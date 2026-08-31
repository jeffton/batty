import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  createFindToolDefinition,
  type FindToolOptions,
  type InlineExtension,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { battyActivePiToolNames, isPiShellToolName } from "@/shared/pi-tools";
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

export function createEnvironmentReloadExtension(battyDir: string): InlineExtension {
  return {
    name: "batty-environment",
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", async (event) => {
        if (isPiShellToolName(event.toolName)) {
          await loadEnvironmentFile(battyDir);
        }
      });
    },
  };
}

export const BATTY_FIND_DEFAULT_LIMIT = 100;

const battyFindSchema = Type.Object({
  pattern: Type.String({
    description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
  }),
  path: Type.Optional(
    Type.String({ description: "Directory to search in (default: current directory)" }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum number of results (default: ${BATTY_FIND_DEFAULT_LIMIT})`,
    }),
  ),
});

export function createFindDefaultsExtension(
  cwd: string,
  options?: FindToolOptions,
): InlineExtension {
  return {
    name: "batty-find-defaults",
    hidden: true,
    factory: (pi) => {
      const findTool = createFindToolDefinition(cwd, options);
      pi.registerTool({
        ...findTool,
        description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${BATTY_FIND_DEFAULT_LIMIT} results or 50KB (whichever is hit first).`,
        parameters: battyFindSchema,
        execute(toolCallId, params, signal, onUpdate, ctx) {
          return findTool.execute(
            toolCallId,
            { ...params, limit: params.limit ?? BATTY_FIND_DEFAULT_LIMIT },
            signal,
            onUpdate,
            ctx,
          );
        },
      });
    },
  };
}

export interface CreatePiAgentSessionOptions {
  config: AppConfig;
  workspace: WorkspaceInfo;
  sessionManager: SessionManager;
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
}: CreatePiAgentSessionOptions): Promise<Awaited<ReturnType<typeof createAgentSession>>> {
  const agentDir = battyAgentDir(config);
  const settings = await loadBattySettings(config, workspace.path);
  const settingsManager = SettingsManager.inMemory({
    ...settings,
    sessionDir: workspaceSessionDir(config, workspace.id),
  });
  const persistedPrompt = findBattySystemPromptSnapshot(sessionManager.getEntries());
  const systemPrompt = await loadBattyPromptFile(workspace.path, agentDir, "SYSTEM.md");
  const appendSystemPrompt = await loadBattyPromptFile(
    workspace.path,
    agentDir,
    "APPEND_SYSTEM.md",
  );
  const workspaceRoot = path.resolve(workspace.path);
  const globalAgentsPath = path.resolve(path.join(agentDir, "AGENTS.md"));
  const resourcePaths = battyResourcePaths(config, workspace.path, settings);
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace.path,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: resourcePaths.extensions,
    extensionFactories: [
      createEnvironmentReloadExtension(config.battyDir),
      createFindDefaultsExtension(workspace.path),
    ],
    additionalSkillPaths: resourcePaths.skills,
    additionalPromptTemplatePaths: resourcePaths.prompts,
    additionalThemePaths: resourcePaths.themes,
    agentsFilesOverride: (base) => ({
      agentsFiles: base.agentsFiles.filter((file) => {
        const resolved = path.resolve(file.path);
        return resolved === globalAgentsPath || resolved === path.join(workspaceRoot, "AGENTS.md");
      }),
    }),
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => {
      const base = appendSystemPrompt ? [appendSystemPrompt] : [];
      const appendedBattyPrompt = findBattySystemPromptSnapshot(
        sessionManager.getEntries(),
      )?.appendedPrompt;
      return appendedBattyPrompt ? [...base, appendedBattyPrompt] : base;
    },
  });
  await resourceLoader.reload();

  const result = await createAgentSession({
    cwd: workspace.path,
    agentDir,
    modelRuntime,
    sessionManager,
    settingsManager,
    resourceLoader,
    ...(model ? { model: model as never } : {}),
    ...(thinkingLevel ? { thinkingLevel: thinkingLevel as AgentSession["thinkingLevel"] } : {}),
    customTools: customTools as never,
    noTools: "builtin",
  });

  result.session.setActiveToolsByName(
    battyActivePiToolNames(result.session.getActiveToolNames(), process.platform),
  );

  if (!persistedPrompt) {
    const restoredContext = sessionManager.buildSessionContext();
    const selectedModel =
      result.session.model != null
        ? modelKey(result.session.model as PiModel)
        : restoredContext.model != null
          ? `${restoredContext.model.provider}/${restoredContext.model.modelId}`
          : (model && modelKey(model)) || "unknown";
    const selectedThinkingLevel =
      result.session.thinkingLevel || restoredContext.thinkingLevel || thinkingLevel || "off";
    const snapshot = buildBattySystemPromptSnapshot(
      workspace,
      selectedModel,
      selectedThinkingLevel,
      new Date(),
      path.join(config.selfPath, "README.md"),
      getCurrentDailySessionDate(config, sessionManager),
    );

    sessionManager.appendCustomEntry(BATTY_SYSTEM_PROMPT_CUSTOM_TYPE, snapshot);
    await resourceLoader.reload();
    result.session.setActiveToolsByName(result.session.getActiveToolNames());
  }

  return result;
}

export async function refreshBattySystemPrompt(
  config: AppConfig,
  webSession: Pick<WebSession, "workspace" | "session">,
): Promise<void> {
  const model = webSession.session.model
    ? modelKey(webSession.session.model as PiModel)
    : "unknown";
  const snapshot = buildBattySystemPromptSnapshot(
    webSession.workspace,
    model,
    webSession.session.thinkingLevel,
    new Date(),
    path.join(config.selfPath, "README.md"),
    getCurrentDailySessionDate(config, webSession.session.sessionManager),
  );

  webSession.session.sessionManager.appendCustomEntry(BATTY_SYSTEM_PROMPT_CUSTOM_TYPE, snapshot);
  await webSession.session.resourceLoader.reload();
  webSession.session.setActiveToolsByName(webSession.session.getActiveToolNames());
}

export function getCurrentDailySessionDate(
  config: Pick<AppConfig, "cronDailySessionStartTime">,
  sessionManager: SessionManager,
): string | undefined {
  return findDailyCronSessionBinding(
    sessionManager.getEntries(),
    toLocalIsoDate(new Date(), config.cronDailySessionStartTime),
  )?.date;
}
