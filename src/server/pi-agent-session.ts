import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { WorkspaceInfo } from "@/shared/types";
import type { AppConfig } from "./config";
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
import type { RuntimeNotice } from "./runtime-notices";
import type { PiModel, WebSession } from "./pi-service-types";
import { modelKey } from "./pi-service-types";

export interface CreatePiAgentSessionOptions {
  config: AppConfig;
  workspace: WorkspaceInfo;
  sessionManager: SessionManager;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  customTools: Array<ToolDefinition<any>>;
  consumeRuntimeNotices: (sessionId: string) => RuntimeNotice[];
  model?: PiModel;
  thinkingLevel?: string;
}

export async function createPiAgentSession({
  config,
  workspace,
  sessionManager,
  authStorage,
  modelRegistry,
  customTools,
  consumeRuntimeNotices,
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
    additionalSkillPaths: resourcePaths.skills,
    additionalPromptTemplatePaths: resourcePaths.prompts,
    additionalThemePaths: resourcePaths.themes,
    extensionFactories: [
      (pi) => {
        pi.on("before_agent_start", async (event, ctx) => {
          const notices = consumeRuntimeNotices(ctx.sessionManager.getSessionId());
          if (notices.length === 0) {
            return undefined;
          }

          return {
            systemPrompt: [event.systemPrompt, ...notices.map((notice) => notice.systemPrompt)]
              .filter((part) => part.trim().length > 0)
              .join("\n\n"),
          };
        });
      },
    ],
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
    authStorage,
    modelRegistry,
    sessionManager,
    settingsManager,
    resourceLoader,
    ...(model ? { model: model as never } : {}),
    ...(thinkingLevel ? { thinkingLevel: thinkingLevel as AgentSession["thinkingLevel"] } : {}),
    customTools: customTools as never,
  });

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
