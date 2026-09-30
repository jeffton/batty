import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import {
  createAgentSession,
  createBashToolDefinition,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type McpStatusSnapshot,
  createFindToolDefinition,
  createGrepToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  DefaultResourceLoader,
  DefaultPackageManager,
  SettingsManager,
  type ExtensionFactory,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
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
import { AgentSessionController } from "./agent-session-controller";
import { SessionStore } from "./session-store";
import { createArtifactExtension, createTrackedFileTools } from "./agent-file-changes";
import { loadBattyMcpConfig, createBattyMcpCredentials, battyMcpLogPath } from "./mcp-settings";

export const BATTY_FIND_DEFAULT_LIMIT = 100;

export interface CreatePiAgentSessionOptions {
  config: AppConfig;
  workspace: WorkspaceInfo;
  sessionManager: SessionStore;
  modelRuntime: ModelRuntime;
  customTools: Array<ToolDefinition<any>>;
  model?: PiModel;
  thinkingLevel?: string;
  extensionFactories?: ExtensionFactory[];
  onMcpStatusChange?: (status: McpStatusSnapshot) => void;
}

export async function createPiAgentSession({
  config,
  workspace,
  sessionManager,
  modelRuntime,
  customTools,
  model,
  thinkingLevel,
  extensionFactories = [],
  onMcpStatusChange,
}: CreatePiAgentSessionOptions): Promise<{
  session: AgentSessionController;
  modelFallbackMessage?: string;
}> {
  const agentDir = battyAgentDir(config);
  const settings = await loadBattySettings(config, workspace.path);
  const resourcePaths = battyResourcePaths(config, workspace.path, settings);
  const availablePaths: typeof resourcePaths = {
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  };
  for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
    for (const resourcePath of resourcePaths[kind]) {
      const configuredPath =
        resourcePath === "~"
          ? homedir()
          : resourcePath.startsWith("~/") ||
              (process.platform === "win32" && resourcePath.startsWith("~\\"))
            ? path.join(homedir(), resourcePath.slice(2))
            : resourcePath;
      if (settings[kind]?.includes(resourcePath)) {
        await fs.access(configuredPath);
        availablePaths[kind].push(configuredPath);
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
  const restored = await sessionManager.configuration();
  const selected = model
    ? modelRuntime.getModel(model.provider, model.id)
    : restored
      ? modelRuntime.getModel(restored.model.provider, restored.model.modelId)
      : settings.defaultProvider && settings.defaultModel
        ? modelRuntime.getModel(settings.defaultProvider, settings.defaultModel)
        : undefined;
  if (!selected)
    throw new Error("Configure an available default model before creating this session");

  let session!: AgentSessionController;
  const withEnvironment = <T extends TSchema, D, S>(
    tool: ToolDefinition<T, D, S>,
  ): ToolDefinition<T, D, S> => ({
    ...tool,
    async execute(...args) {
      await loadEnvironmentFile(config.battyDir);
      return tool.execute(...args);
    },
  });
  const shellOptions = {
    spawnHook: (spawn: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({
      ...spawn,
      env: {
        ...spawn.env,
        PI_SESSION_ID: session.sessionId,
        PI_SESSION_FILE: session.sessionFile,
        PI_PROVIDER: session.model!.provider,
        PI_MODEL: session.model!.id,
        PI_REASONING_LEVEL: session.thinkingLevel,
      },
    }),
  };
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
  const tools = [
    createReadToolDefinition(workspace.path),
    ...createTrackedFileTools(workspace.path),
    withEnvironment(
      createBashToolDefinition(workspace.path, {
        ...shellOptions,
        shellPath: typeof settings.shellPath === "string" ? settings.shellPath : undefined,
        commandPrefix:
          typeof settings.shellCommandPrefix === "string" ? settings.shellCommandPrefix : undefined,
      }),
    ),
    findWithDefaults,
    createGrepToolDefinition(workspace.path),
    ...(process.platform === "win32"
      ? [withEnvironment(createPowerShellToolDefinition(workspace.path, shellOptions))]
      : []),
    ...customTools,
  ];
  const migration = sessionManager
    .getBranch()
    .findLast(
      (entry) => entry.type === "custom" && entry.customType === "batty-agent-session-migration",
    );
  const importedToolNames =
    migration?.type === "custom"
      ? (migration.data as { configuration?: { activeToolNames: string[] } }).configuration
          ?.activeToolNames
      : undefined;
  const settingsManager = SettingsManager.inMemory({
    ...settings,
    sessionDir: workspaceSessionDir(config, workspace.id),
    defaultTools: battyActivePiToolNames(
      importedToolNames ?? [...tools.map((tool) => tool.name), "codemode"],
      process.platform,
    ),
  });
  const workspaceRoot = path.resolve(workspace.path);
  const globalAgentsPath = path.resolve(agentDir, "AGENTS.md");
  const systemPrompt = await loadBattyPromptFile(workspace.path, agentDir, "SYSTEM.md");
  const appendSystemPrompt = await loadBattyPromptFile(
    workspace.path,
    agentDir,
    "APPEND_SYSTEM.md",
  );
  // Directory settings use Pi's discovery rules; CLI extension sources treat a
  // directory as a package/module rather than an extension collection.
  const extensionResources = await new DefaultPackageManager({
    cwd: workspace.path,
    agentDir,
    settingsManager: SettingsManager.inMemory({ extensions: availablePaths.extensions }),
  }).resolve();
  const extensionPaths = extensionResources.extensions
    .filter(
      (resource) =>
        resource.enabled &&
        resource.metadata.source === "local" &&
        resource.metadata.origin === "top-level",
    )
    .map((resource) => resource.path);
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace.path,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      {
        name: "codemode",
        builtin: true,
        replaceable: true,
        factory: createCodemodeExtension({ models: false }),
      },
      {
        name: "tool-search",
        builtin: true,
        replaceable: true,
        factory: createToolSearchExtension(),
      },
      {
        name: "mcp",
        builtin: true,
        replaceable: true,
        factory: createMcpExtension({
          loadConfig: (ctx) => loadBattyMcpConfig(config, workspace.path, ctx.isProjectTrusted()),
          credentials: createBattyMcpCredentials(config),
          logPath: battyMcpLogPath(config),
          onStatusChange: onMcpStatusChange,
        }),
      },
      createArtifactExtension(),
      ...extensionFactories,
    ],
    additionalExtensionPaths: [
      "builtin:codemode",
      "builtin:tool-search",
      "builtin:mcp",
      ...extensionPaths,
    ],
    additionalSkillPaths: availablePaths.skills,
    additionalPromptTemplatePaths: availablePaths.prompts,
    additionalThemePaths: availablePaths.themes,
    agentsFilesOverride: (base) => ({
      agentsFiles: base.agentsFiles.filter((file) => {
        const resolved = path.resolve(file.path);
        return resolved === globalAgentsPath || resolved === path.join(workspaceRoot, "AGENTS.md");
      }),
    }),
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () =>
      [
        "Use read to examine files instead of cat or sed. Use write for new files or complete rewrites. Use edit for precise changes; merge nearby changes and do not emit overlapping edits.",
        ...customTools.flatMap((tool) => tool.promptGuidelines ?? []),
        appendSystemPrompt,
        findBattySystemPromptSnapshot(sessionManager.getEntries())?.appendedPrompt,
      ].filter((value): value is string => !!value),
  });
  await resourceLoader.reload();
  for (const diagnostic of [
    ...resourceLoader.getSkills().diagnostics,
    ...resourceLoader.getPrompts().diagnostics,
  ])
    console.warn("Pi resource diagnostic", {
      workspaceId: workspace.id,
      sessionId: sessionManager.getSessionId(),
      ...diagnostic,
    });
  const extensions = resourceLoader.getExtensions();
  if (extensions.errors.length)
    throw new Error(extensions.errors.map((error) => `${error.path}: ${error.error}`).join("\n"));
  const result = await createAgentSession({
    cwd: workspace.path,
    agentDir,
    modelRuntime,
    model: selected,
    thinkingLevel: (thinkingLevel ??
      restored?.thinkingLevel ??
      settings.defaultThinkingLevel ??
      "off") as ThinkingLevel,
    sessionManager: sessionManager.native,
    settingsManager,
    resourceLoader,
    customTools: tools as unknown as ToolDefinition[],
  });
  session = await AgentSessionController.create(result.session, sessionManager);
  try {
    if (!findBattySystemPromptSnapshot(sessionManager.getEntries()))
      await refreshBattySystemPrompt(config, { workspace, session });
    await result.session.bindExtensions({
      mode: "rpc",
      onError: (error) => {
        throw new Error(`Pi extension ${error.extensionPath}: ${error.error}`);
      },
    });
    if (importedToolNames) {
      const battyTools = new Set(tools.map((tool) => tool.name));
      const extensionTools = result.session
        .getActiveToolNames()
        .filter((name) => !battyTools.has(name));
      result.session.setActiveToolsByName(
        battyActivePiToolNames(
          [...importedToolNames, ...extensionTools, "codemode"],
          process.platform,
        ),
      );
    }
    return { session, modelFallbackMessage: result.modelFallbackMessage };
  } catch (error) {
    await session.dispose();
    throw error;
  }
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
  await webSession.session.sdk.reload();
}

export function getCurrentDailySessionDate(
  config: Pick<AppConfig, "cronDailySessionStartTime">,
  sessionManager: Pick<SessionStore, "getEntries">,
): string | undefined {
  return findDailyCronSessionBinding(
    sessionManager.getEntries(),
    toLocalIsoDate(new Date(), config.cronDailySessionStartTime),
  )?.date;
}
