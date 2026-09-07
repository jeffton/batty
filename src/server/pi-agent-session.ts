import fs from "node:fs/promises";
import path from "node:path";
import {
  BACKGROUND_CONTEXT as context,
  convertToLlm,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  formatSkillsForSystemPrompt,
  loadPromptTemplates,
  type AgentHarnessTool,
  type ExecutionToolContext,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { TrackedExecutionEnv, trackFileChanges } from "./harness-file-changes";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createPowerShellToolDefinition,
  DefaultResourceLoader,
  formatDimensionNote,
  resizeImage,
  SettingsManager,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { battyActivePiToolNames } from "@/shared/pi-tools";
import type { WorkspaceInfo } from "@/shared/types";
import { type AppConfig, loadEnvironmentFile } from "./config";
import {
  buildBattySystemPromptSnapshot,
  BATTY_SYSTEM_PROMPT_CUSTOM_TYPE,
  findBattySystemPromptSnapshot,
} from "./batty-system-prompt";
import { findDailyCronSessionBinding, toLocalIsoDate } from "./cron-session";
import {
  battyAgentDir,
  battyResourcePaths,
  loadBattyPromptFile,
  loadBattySettings,
  workspaceSessionDir,
} from "./pi-paths";
import type { PiModel, WebSession } from "./pi-service-types";
import { modelKey } from "./pi-service-types";
import { HarnessController } from "./harness-controller";
import { HarnessSessionStore } from "./harness-session-store";

export const BATTY_FIND_DEFAULT_LIMIT = 100;

export interface CreatePiAgentSessionOptions {
  config: AppConfig;
  workspace: WorkspaceInfo;
  sessionManager: HarnessSessionStore;
  modelRuntime: ModelRuntime;
  customTools: Array<ToolDefinition<any>>;
  model?: PiModel;
  thinkingLevel?: string;
}

export async function createPiAgentSession({
  config,
  workspace,
  sessionManager,
  modelRuntime,
  customTools,
  model,
  thinkingLevel,
}: CreatePiAgentSessionOptions): Promise<{
  session: HarnessController;
  modelFallbackMessage?: string;
}> {
  const agentDir = battyAgentDir(config);
  const settings = await loadBattySettings(config, workspace.path);
  const settingsManager = SettingsManager.inMemory({
    ...settings,
    sessionDir: workspaceSessionDir(config, workspace.id),
  });
  const resourcePaths = battyResourcePaths(config, workspace.path, settings);
  const availablePaths: typeof resourcePaths = {
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  };
  for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
    for (const resourcePath of resourcePaths[kind]) {
      if (settings[kind]?.includes(resourcePath)) {
        availablePaths[kind].push(resourcePath);
        continue;
      }
      try {
        await fs.access(resourcePath);
        availablePaths[kind].push(resourcePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  const workspaceRoot = path.resolve(workspace.path);
  const globalAgentsPath = path.resolve(agentDir, "AGENTS.md");
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace.path,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: availablePaths.extensions,
    additionalSkillPaths: availablePaths.skills,
    additionalPromptTemplatePaths: availablePaths.prompts,
    additionalThemePaths: availablePaths.themes,
    agentsFilesOverride: (base) => ({
      agentsFiles: base.agentsFiles.filter((file) => {
        const resolved = path.resolve(file.path);
        return resolved === globalAgentsPath || resolved === path.join(workspaceRoot, "AGENTS.md");
      }),
    }),
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();
  const extensions = resourceLoader.getExtensions();
  if (extensions.errors.length)
    throw new Error(extensions.errors.map((error) => `${error.path}: ${error.error}`).join("\n"));
  if (extensions.extensions.length) {
    throw new Error(
      "Coding-agent extensions require migration to AgentHarness hooks/tools: " +
        extensions.extensions.map((extension) => extension.path).join(", "),
    );
  }
  const restored = await sessionManager.configuration();
  const selected =
    model ??
    (restored
      ? modelRuntime.getModel(restored.model.provider, restored.model.modelId)
      : settings.defaultProvider && settings.defaultModel
        ? modelRuntime.getModel(settings.defaultProvider, settings.defaultModel)
        : undefined);
  if (!selected)
    throw new Error("Configure an available default model before creating this session");
  const env = new TrackedExecutionEnv({
    cwd: workspace.path,
    shellPath: settingsManager.getShellPath(),
  });
  let session!: HarnessController;
  const adapt = (
    tool: ToolDefinition<any, any, any>,
    replay: "safe" | "never",
  ): AgentHarnessTool<ExecutionToolContext, any> => ({
    ...tool,
    replay,
    async execute(id, args, onUpdate, _tools, invocation, invocationContext) {
      if (tool.name === "powershell") await loadEnvironmentFile(config.battyDir);
      const result = await tool.execute(id, args, invocationContext.abortSignal, onUpdate, {
        invocation,
        childSessionId: () => sessionManager.native.idGenerator.next(),
        cwd: workspace.path,
        sessionManager,
        model: session.model,
        thinkingLevel: session.thinkingLevel,
      } as never);
      return (result as { isError?: boolean }).isError
        ? { ...result, details: { ...(result.details as object), battyToolError: true } }
        : result;
    },
  });
  const find = createFindToolDefinition(workspace.path);
  const findWithDefaults: typeof find = {
    ...find,
    execute: (id, args, signal, update, ctx) =>
      find.execute(
        id,
        { ...args, limit: args.limit ?? BATTY_FIND_DEFAULT_LIMIT },
        signal,
        update,
        ctx,
      ),
  };
  const nativeTools: AgentHarnessTool<ExecutionToolContext, any>[] = [
    { ...createReadTool(), replay: "safe" },
    trackFileChanges(createWriteTool()),
    trackFileChanges(createEditTool()),
    createBashTool({
      commandPrefix: settingsManager.getShellCommandPrefix(),
      prepare: async (execution) => {
        await loadEnvironmentFile(config.battyDir);
        Object.assign(execution.env, {
          PI_SESSION_ID: session.sessionId,
          PI_SESSION_FILE: session.sessionFile,
          PI_PROVIDER: session.model?.provider ?? "",
          PI_MODEL: session.model?.id ?? "",
          PI_REASONING_LEVEL: session.thinkingLevel,
        });
      },
    }),
    adapt(findWithDefaults as ToolDefinition<any, any, any>, "safe"),
    adapt(createGrepToolDefinition(workspace.path) as ToolDefinition<any, any, any>, "safe"),
    ...(process.platform === "win32"
      ? [
          adapt(
            createPowerShellToolDefinition(workspace.path) as ToolDefinition<any, any, any>,
            "never",
          ),
        ]
      : []),
    ...customTools.map((tool) =>
      adapt(tool, tool.name === "web-search" || tool.name === "subagent" ? "safe" : "never"),
    ),
  ];
  // Resource discovery owns validation and collision precedence. The native skill loader
  // accepts directories, not individual files, so retain the selected files directly.
  const skills = await Promise.all(
    resourceLoader.getSkills().skills.map(async (skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      disableModelInvocation: skill.disableModelInvocation,
      content: await fs.readFile(skill.filePath, "utf8"),
    })),
  );
  const loadedPrompts = await loadPromptTemplates(
    env,
    resourceLoader.getPrompts().prompts.map((prompt) => prompt.filePath),
    context,
  );
  const resourceDiagnostics = [
    ...resourceLoader.getSkills().diagnostics,
    ...resourceLoader.getPrompts().diagnostics,
    ...loadedPrompts.diagnostics,
  ];
  for (const diagnostic of resourceDiagnostics)
    console.warn("Pi resource diagnostic", {
      workspaceId: workspace.id,
      sessionId: sessionManager.getSessionId(),
      ...diagnostic,
    });
  const systemPrompt = await loadBattyPromptFile(workspace.path, agentDir, "SYSTEM.md");
  const appendSystemPrompt = await loadBattyPromptFile(
    workspace.path,
    agentDir,
    "APPEND_SYSTEM.md",
  );
  session = await HarnessController.create(
    sessionManager,
    {
      models: modelRuntime,
      model: selected as Model<Api>,
      thinkingLevel: (thinkingLevel ??
        restored?.thinkingLevel ??
        settings.defaultThinkingLevel ??
        "off") as ThinkingLevel,
      tools: nativeTools.map((tool): AgentHarnessTool<ExecutionToolContext, any> => ({
        ...tool,
        async execute(...args) {
          const result = await tool.execute(...args);
          if (!settingsManager.getImageAutoResize()) return result;
          const content = await Promise.all(
            result.content.map(async (block) => {
              if (block.type !== "image") return [block];
              const resized = await resizeImage(Buffer.from(block.data, "base64"), block.mimeType);
              if (!resized) throw new Error(`Cannot resize tool image (${block.mimeType})`);
              const note = formatDimensionNote(resized);
              return [
                { type: "image" as const, data: resized.data, mimeType: resized.mimeType },
                ...(note ? [{ type: "text" as const, text: note }] : []),
              ];
            }),
          );
          return { ...result, content: content.flat() };
        },
      })),
      toolContext: { env },
      activeToolNames: battyActivePiToolNames(
        nativeTools.map((tool) => tool.name),
        process.platform,
      ),
      resources: { skills, promptTemplates: loadedPrompts.promptTemplates },
      toProviderMessages(messages) {
        const converted = convertToLlm(messages);
        if (!settingsManager.getBlockImages()) return converted;
        return converted.map((message) => {
          if (
            (message.role !== "user" && message.role !== "toolResult") ||
            typeof message.content === "string"
          )
            return message;
          return {
            ...message,
            content: message.content.map((block) =>
              block.type === "image"
                ? { type: "text" as const, text: "Image reading is disabled." }
                : block,
            ),
          };
        });
      },
      retry: settingsManager.getRetrySettings(),
      compaction: settingsManager.getCompactionSettings(),
      steeringMode: settingsManager.getSteeringMode(),
      followUpMode: settingsManager.getFollowUpMode(),
      streamOptions: {
        transport: settingsManager.getTransport(),
        ...settingsManager.getProviderRetrySettings(),
      },
      systemPrompt: () =>
        [
          systemPrompt ??
            "You are an expert coding assistant. Help the user by reading files, executing commands, editing code, and writing new files.",
          "Available tools:\n" +
            nativeTools
              .filter((tool) => session.getActiveToolNames().includes(tool.name))
              .map((tool) => `- ${tool.name}: ${tool.description}`)
              .join("\n"),
          "Use read to examine files instead of cat or sed. Use write for new files or complete rewrites. Use edit for precise changes; merge nearby changes and do not emit overlapping edits.",
          ...customTools.flatMap((tool) => tool.promptGuidelines ?? []),
          ...resourceLoader
            .getAgentsFiles()
            .agentsFiles.map((file) => `# Instructions from ${file.path}\n\n${file.content}`),
          appendSystemPrompt,
          findBattySystemPromptSnapshot(sessionManager.getEntries())?.appendedPrompt,
          formatSkillsForSystemPrompt(skills),
          `Current working directory: ${workspace.path}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
    },
    settingsManager,
    resourceLoader,
  );
  session.harness.hooks.on("after_tool", (event) => {
    if ((event.details as { battyToolError?: boolean })?.battyToolError) return { isError: true };
    return undefined;
  });
  // Explicit per-session choices override a fork's inherited lane configuration.
  if (model) await session.setModel(model as Model<Api>);
  if (thinkingLevel) await session.setThinkingLevel(thinkingLevel as ThinkingLevel);
  // v3 sessions did not necessarily record the complete builtin set.
  if (session.getActiveToolNames().length === 0)
    await session.setActiveToolsByName(
      battyActivePiToolNames(
        nativeTools.map((tool) => tool.name),
        process.platform,
      ),
    );
  if (!findBattySystemPromptSnapshot(sessionManager.getEntries()))
    await refreshBattySystemPrompt(config, { workspace, session });
  return { session };
}

export async function refreshBattySystemPrompt(
  config: AppConfig,
  webSession: Pick<WebSession, "workspace" | "session">,
): Promise<void> {
  const snapshot = buildBattySystemPromptSnapshot(
    webSession.workspace,
    webSession.session.model ? modelKey(webSession.session.model) : "unknown",
    webSession.session.thinkingLevel,
    new Date(),
    path.join(config.selfPath, "README.md"),
    getCurrentDailySessionDate(config, webSession.session.sessionManager),
  );
  await webSession.session.sessionManager.appendCustomEntry(
    BATTY_SYSTEM_PROMPT_CUSTOM_TYPE,
    snapshot,
  );
}

export function getCurrentDailySessionDate(
  config: Pick<AppConfig, "cronDailySessionStartTime">,
  sessionManager: Pick<HarnessSessionStore, "getEntries">,
): string | undefined {
  return findDailyCronSessionBinding(
    sessionManager.getEntries(),
    toLocalIsoDate(new Date(), config.cronDailySessionStartTime),
  )?.date;
}
