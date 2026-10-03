import fs from "node:fs/promises";
import path from "node:path";
import {
  ModelRuntime,
  SettingsManager,
  readStoredCredential,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  CronJobSession,
  RunningCronJob,
  RunningSubagent,
  ModelOption,
  ProviderAuthStartResponse,
  ProviderAuthStatus,
  PromptSubmissionResult,
  ProviderUsage,
  PreviousContextMode,
  SessionSnapshot,
  SessionMessagesPage,
  SessionResourcesResponse,
  SessionState,
  SessionSummary,
  ToolExecutionDetails,
  WorkspaceInfo,
} from "@/shared/types";
import type { AppConfig } from "./config";
import { BrowserService } from "./browser-service";
import { hasRestartResponse, waitForRestartResponse } from "./restart-readiness";
import {
  readSubagentRecovery,
  readQueuedSubagentOperations,
  persistQueuedSubagentOperation,
} from "./subagent-recovery";
import { isSessionCheckpointError, SessionCheckpointError } from "./session-checkpoint";
import { closeSharedBrowser } from "./browser-runtime";
import { ModelConfigWatcher } from "./model-config-watcher";
import { resolveModel } from "./model-resolution";
import { getSessionContextUsage, getViewContextUsage } from "./pi-context-usage";
import { createSessionManagerWithPreviousContext } from "./previous-context";
import {
  createPiAgentSession as createPiAgentSessionImpl,
  refreshBattySystemPrompt,
} from "./pi-agent-session";
import { createSessionState, normalizeBlocks, normalizeMessages } from "./pi-state";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { handleSessionEvent } from "./pi-service-agent-events";
import { battyAgentDir, workspaceCronSessionDir, workspaceSessionDir } from "./pi-paths";
import {
  listSessionSummaries as listFastSessionSummaries,
  getSessionSummaryIndex,
  disposeSessionSummaryIndex,
} from "./session-summaries";
import { ProviderAuthService } from "./provider-auth";
import { McpService } from "./mcp-service";
import { ProviderUsageService } from "./provider-usage";
import { SshSocksProxy } from "./ssh-socks-proxy";
import {
  hasParentedCronRunSessionMarker,
  buildCronRunSessionBinding,
  CRON_RUN_SESSION_CUSTOM_TYPE,
} from "./cron-session";
import {
  hasSubagentSessionMarker,
  SUBAGENT_SESSION_CUSTOM_TYPE,
  type SubagentToolDetails,
} from "./subagent";
import { getSessionMessagePage } from "./pi-service-message-page";
import { getQueuedPrompts, removeQueuedPrompt } from "./pi-service-queue";
import { preparePromptFiles } from "./pi-service-uploads";
import { createUiImageResolver, resolveSessionImage } from "./session-images";
import {
  attachSession,
  disposeWebSession,
  isWebSessionDisposing,
  publish,
  requireSession,
  subscribeToSession,
} from "./pi-service-sessions";
import {
  appendRuntimeNoticeMessage,
  resolveOrCreateDailySession,
  resolveSubagentDefaults,
  runDetachedSubagentSession,
  deliverAsyncSubagentResult,
  deliverDetachedSubagentResult,
  runSubagentSerial,
  waitForSubagentQueue,
} from "./pi-service-subagents";
import {
  modelKey,
  sessionUpdatedAt,
  toModelOption,
  type LiveSession,
  type PiModel,
  type SessionSubscriber,
  type UploadedFile,
  type WebSession,
} from "./pi-service-types";
import type { CronService } from "./cron";
import { buildSubagentSteeringRuntimeNotice } from "./runtime-notices";
import {
  deliverCronJobRun,
  deliverCronFollowup,
  deliverSkippedCronJobRun,
  runCronJobSession,
  executeCronOperation,
  type PiServiceCronAdapterContext,
} from "./pi-service-cron-adapter";
import { createPiServiceTools } from "./pi-service-tool-factory";
import type { RuntimeNotice } from "./runtime-notices";
import { SessionReadStateStore } from "./session-read-state";
import { listWorkspaces } from "./workspaces";
import { SessionStore as SessionManager } from "./session-store";
import type {
  AgentSessionController as AgentSession,
  SessionControllerEvent,
} from "./agent-session-controller";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type { UploadedFile } from "./pi-service-types";

function leafBeforeCurrentTurn(branch: SessionEntry[]): string | null | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]!;
    if (entry.type === "message" && entry.message.role === "user") {
      return entry.parentId;
    }
  }
  return undefined;
}

export class PiService {
  private closing?: Promise<void>;
  readonly mcp: McpService;
  private readonly config: AppConfig;
  private readonly modelRuntime: ModelRuntime;
  private readonly modelConfigWatcher: ModelConfigWatcher;
  private readonly providerAuthService: ProviderAuthService;
  private readonly providerUsageService: ProviderUsageService;
  private readonly browserService: BrowserService;
  private readonly sessions = new Map<string, WebSession>();
  private readonly liveSessions = new Map<string, LiveSession>();
  private readonly runningSubagents = new Map<string, RunningSubagent>();
  private readonly subagentQueues = new Map<string, Promise<void>>();
  private readonly subagentOperations = new Map<string, Promise<void>>();
  private readonly subagentOperationAsync = new Map<string, boolean>();
  private readonly cronSessionResolutions = new Map<string, Promise<SessionState>>();
  private readonly sessionOpenPromises = new Map<string, Promise<SessionState>>();
  private readonly sessionControllers = new Map<
    string,
    ReturnType<typeof createPiAgentSessionImpl>
  >();
  private readonly onAgentCompleted: ((session: SessionState) => Promise<void>) | undefined;
  private readonly onWorkspaceUpdated: ((workspaceId: string) => Promise<void>) | undefined;
  private readonly cronService: CronService;
  private readonly sessionReadState: SessionReadStateStore;

  private constructor(
    config: AppConfig,
    cronService: CronService,
    modelRuntime: ModelRuntime,
    modelConfigWatcher: ModelConfigWatcher,
    sessionReadState: SessionReadStateStore,
    onAgentCompleted?: (session: SessionState) => Promise<void>,
    onWorkspaceUpdated?: (workspaceId: string) => Promise<void>,
  ) {
    this.config = config;
    this.cronService = cronService;
    this.modelRuntime = modelRuntime;
    this.mcp = new McpService(config, modelRuntime, (workspaceId) => this.reloadMcp(workspaceId));
    this.modelConfigWatcher = modelConfigWatcher;
    this.sessionReadState = sessionReadState;
    this.onAgentCompleted = onAgentCompleted;
    this.onWorkspaceUpdated = onWorkspaceUpdated;
    this.browserService = new BrowserService(
      config.browserTailscaleSshDestination
        ? new SshSocksProxy(config.browserTailscaleSshDestination)
        : undefined,
      config.browserMaxTabs,
    );
    const authPath = path.join(battyAgentDir(config), "auth.json");
    const settingsManager = SettingsManager.create(process.cwd(), battyAgentDir(config));
    this.providerAuthService = new ProviderAuthService(
      modelRuntime,
      (providerId) => readStoredCredential(providerId, authPath),
      async () => {
        const deviceId = settingsManager.getOrCreateDeviceId();
        await settingsManager.flush();
        const errors = settingsManager.drainErrors();
        if (errors.length) throw errors[0]!.error;
        return deviceId;
      },
    );
    this.providerUsageService = new ProviderUsageService(modelRuntime, (providerId) =>
      readStoredCredential(providerId, authPath),
    );
  }

  static async create(
    config: AppConfig,
    cronService: CronService,
    onAgentCompleted?: (session: SessionState) => Promise<void>,
    onWorkspaceUpdated?: (workspaceId: string) => Promise<void>,
  ): Promise<PiService> {
    const agentDir = battyAgentDir(config);
    const modelsPath = path.join(agentDir, "models.json");
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath,
    });
    const modelConfigWatcher = new ModelConfigWatcher(modelsPath, modelRuntime);
    await modelConfigWatcher.initialize();
    const sessionReadState = await SessionReadStateStore.create(config.battyDir);
    await getSessionSummaryIndex(config);
    const workspaces = await listWorkspaces(config);
    const existingSessions = (
      await Promise.all(workspaces.map((workspace) => listFastSessionSummaries(config, workspace)))
    ).flat();
    await sessionReadState.initializeBaseline(existingSessions, Date.now());
    return new PiService(
      config,
      cronService,
      modelRuntime,
      modelConfigWatcher,
      sessionReadState,
      onAgentCompleted,
      onWorkspaceUpdated,
    );
  }

  async restoreDurableSessions(workspaces: WorkspaceInfo[]): Promise<void> {
    for (const workspace of workspaces) {
      const root = workspaceSessionDir(this.config, workspace.id);
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".sqlite")) continue;
        const file = path.join(entry.parentPath, entry.name);
        const recovery = await SessionManager.inspectRecovery(file);
        if (recovery.parentSession) {
          const snapshot = await SessionManager.read(file);
          const operation = readSubagentRecovery(snapshot);
          const queued = readQueuedSubagentOperations(snapshot);
          const requests = [
            ...(operation ? [operation.options] : []),
            ...queued.map((item) => item.options),
          ];
          if (requests.length > 0) {
            let releaseQueue!: () => void;
            const tail = new Promise<void>((resolve) => {
              releaseQueue = resolve;
            });
            this.subagentOperations.set(snapshot.metadata.id, tail);
            void (async () => {
              try {
                for (const options of requests) {
                  if (this.closing) throw new SessionCheckpointError();
                  let accepted!: () => void;
                  const deliveryAccepted = new Promise<void>((resolve) => {
                    accepted = resolve;
                  });
                  const running = this.runDetachedSubagentSession({
                    ...options,
                    onDelivered: accepted,
                  });
                  this.subagentOperations.set(snapshot.metadata.id, tail);
                  void running.catch((error) => {
                    if (!isSessionCheckpointError(error))
                      console.error("Failed to recover subagent", error);
                  });
                  await (options.deliveryMode === "prompt"
                    ? Promise.race([deliveryAccepted, running])
                    : running);
                }
              } finally {
                releaseQueue();
                if (this.subagentOperations.get(snapshot.metadata.id) === tail)
                  this.subagentOperations.delete(snapshot.metadata.id);
              }
            })().catch((error) => {
              if (!isSessionCheckpointError(error))
                console.error("Failed to recover subagent queue", error);
            });
            continue;
          }
        }
        if (recovery.pending) await this.openSession(workspace, file);
      }
    }
  }

  async waitForRestartResponse(sessionPath?: string, afterEntryId?: string): Promise<void> {
    if (!sessionPath) return;
    if (!afterEntryId) throw new Error("Restart requires the deploying response anchor");
    const canonical = path.resolve(sessionPath);
    const deploying = [...this.liveSessions.values()].find(
      ({ session }) => session.sessionFile === canonical,
    );
    if (deploying) {
      await waitForRestartResponse(deploying.session, afterEntryId);
      return;
    }
    const snapshot = await SessionManager.read(canonical);
    const creating = this.sessionControllers.get(snapshot.metadata.id);
    if (creating) {
      await waitForRestartResponse((await creating).session, afterEntryId);
    } else if (!hasRestartResponse(snapshot.entries, afterEntryId)) {
      throw new Error("Deploying turn ended without a final response");
    }
  }

  async prepareRestart(sessionPath?: string, afterEntryId?: string): Promise<void> {
    await this.waitForRestartResponse(sessionPath, afterEntryId);
    await this.dispose();
  }

  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      await this.modelConfigWatcher.dispose();
      await this.providerAuthService.dispose();
      const loaded = await Promise.allSettled(this.sessionControllers.values());
      const closed = await Promise.allSettled(
        loaded.flatMap((result) =>
          result.status === "fulfilled" ? [result.value.session.dispose()] : [],
        ),
      );
      const failures = [...loaded, ...closed].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      await this.mcp.dispose();
      await this.browserService.dispose();
      await closeSharedBrowser();
      await disposeSessionSummaryIndex(this.config);
      if (failures.length) throw new AggregateError(failures, "Failed to checkpoint sessions");
    })());
  }

  private assertRunning(): void {
    if (this.closing) throw Object.assign(new Error("Batty is restarting"), { statusCode: 503 });
  }

  private registerLiveSession(workspace: WorkspaceInfo, session: AgentSession): void {
    this.liveSessions.set(session.sessionId, { workspace, session });
  }

  private async reloadMcp(workspaceId?: string): Promise<void> {
    await Promise.all(
      [...this.liveSessions.values()]
        .filter((live) => workspaceId === undefined || live.workspace.id === workspaceId)
        .map((live) => live.session.reloadResources()),
    );
  }

  private unregisterLiveSession(sessionId: string): void {
    this.mcp.forget(sessionId);
    this.sessionControllers.delete(sessionId);
    this.liveSessions.delete(sessionId);
  }

  getProviderAuthStatus(): ProviderAuthStatus {
    return this.providerAuthService.getStatus();
  }

  getProviderAuthAttemptStatus(attemptId: string): { completed: boolean } {
    return this.providerAuthService.getAttemptStatus(attemptId);
  }

  async startProviderAuth(providerId: "openai"): Promise<ProviderAuthStartResponse> {
    return this.providerAuthService.start(providerId);
  }

  async getProviderUsage(provider: string, model: string): Promise<ProviderUsage> {
    return this.providerUsageService.getUsage(provider, model);
  }

  async completeProviderAuth(attemptId: string, callbackUrl: string): Promise<ProviderAuthStatus> {
    await this.providerAuthService.complete(attemptId, callbackUrl);
    return this.providerAuthService.getStatus();
  }

  async setProviderApiKey(
    providerId: "google" | "openrouter",
    apiKey: string,
  ): Promise<ProviderAuthStatus> {
    return this.providerAuthService.setApiKey(providerId, apiKey);
  }

  async listModels(): Promise<ModelOption[]> {
    const models = this.modelRuntime.getAvailableSnapshot();
    return models.map(toModelOption).sort((a, b) => a.label.localeCompare(b.label));
  }

  async listSessionSummaries(workspace: WorkspaceInfo): Promise<SessionSummary[]> {
    const summaries = await listFastSessionSummaries(this.config, workspace);
    const jobsById = new Map(
      this.cronService.listJobs(workspace.id).map((job) => [job.id, job] as const),
    );
    const inlineCronSessionIds = new Set(
      this.cronService
        .listRunningJobs(workspace.id)
        .filter((run) => jobsById.get(run.jobId)?.session.kind === "daily-inline")
        .map((run) => run.sessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );
    return summaries.map((summary) => {
      const webSession = this.sessions.get(summary.sessionId);
      const isInProgress = Boolean(
        webSession &&
        !webSession.ephemeral &&
        !inlineCronSessionIds.has(summary.sessionId) &&
        !webSession.agentCompleted &&
        webSession.session.isStreaming,
      );
      const hasUnread = this.sessionReadState.hasUnread(
        summary.sessionId,
        summary.lastAssistantReplyAt,
      );
      return {
        ...summary,
        ...(isInProgress ? { isInProgress: true } : {}),
        ...(hasUnread ? { hasUnread: true } : {}),
      };
    });
  }

  async markSessionRead(
    workspace: WorkspaceInfo,
    sessionId: string,
    readThrough: number,
  ): Promise<void> {
    const summary = (await listFastSessionSummaries(this.config, workspace)).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (summary?.lastAssistantReplyAt != null) {
      await this.sessionReadState.markRead(
        sessionId,
        Math.min(readThrough, summary.lastAssistantReplyAt),
      );
      await this.notifyWorkspaceUpdated(workspace.id);
    }
  }

  async createSession(
    workspace: WorkspaceInfo,
    options?: { modelId?: string; thinkingLevel?: string; ephemeral?: boolean },
  ): Promise<SessionState> {
    this.assertRunning();
    const sessionOptions = {
      ...(options?.modelId ? { modelId: options.modelId } : {}),
      ...(options?.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    };
    const result = await this.createPiAgentSession(
      workspace,
      await SessionManager.create(workspace.path, workspaceSessionDir(this.config, workspace.id)),
      sessionOptions,
    );

    const webSession = this.attachSession(
      workspace,
      result.session,
      result.modelFallbackMessage,
      options?.ephemeral ?? false,
    );
    await this.notifyWorkspaceUpdated(workspace.id);
    return this.getState(webSession.id);
  }

  private async createCronSession(
    workspace: WorkspaceInfo,
    options: {
      jobId: string;
      runId: string;
      modelId: string;
      thinkingLevel: string;
      parentSessionId?: string;
      previousContext?: {
        sourceSessionPath: string;
        mode: true | "chat-only";
      };
    },
  ): Promise<SessionState> {
    const sessionDir = options.parentSessionId
      ? workspaceCronSessionDir(this.config, workspace.id, options.jobId, options.runId)
      : workspaceSessionDir(this.config, workspace.id);
    const contextLeafId = options.previousContext
      ? await this.resolveCronContextCopyLeafId(
          options.parentSessionId,
          options.previousContext.sourceSessionPath,
        )
      : null;
    const { manager: sessionManager, chatOnlyMessages } =
      await createSessionManagerWithPreviousContext({
        cwd: workspace.path,
        targetRoot: sessionDir,
        sourceSessionPath: options.previousContext?.sourceSessionPath,
        leafId: contextLeafId,
        mode: options.previousContext?.mode ?? false,
      });
    const result = await this.createPiAgentSession(workspace, sessionManager, {
      modelId: options.modelId,
      thinkingLevel: options.thinkingLevel,
    });
    for (const message of chatOnlyMessages ?? []) {
      await result.session.sessionManager.appendMessage(message);
    }
    await result.session.sessionManager.appendCustomEntry(
      CRON_RUN_SESSION_CUSTOM_TYPE,
      buildCronRunSessionBinding({
        jobId: options.jobId,
        runId: options.runId,
        parentSessionId: options.parentSessionId,
      }),
    );
    const webSession = this.attachSession(
      workspace,
      result.session,
      result.modelFallbackMessage,
      Boolean(options.parentSessionId),
    );
    await this.notifyWorkspaceUpdated(workspace.id);
    return this.getState(webSession.id);
  }

  private async resolveCronContextCopyLeafId(
    parentSessionId: string | undefined,
    sourceSessionPath: string,
  ): Promise<string | null> {
    const webSession = parentSessionId
      ? (this.sessions.get(parentSessionId) ??
        [...this.sessions.values()].find(
          (candidate) => candidate.session.sessionFile === sourceSessionPath,
        ))
      : undefined;
    if (!webSession) {
      const { entries } = await SessionManager.read(sourceSessionPath, { readOnly: true });
      return entries.at(-1)?.id ?? null;
    }
    const sessionManager = webSession.session.sessionManager;

    if (!webSession.session.isStreaming) {
      return sessionManager.getLeafId();
    }

    return leafBeforeCurrentTurn(sessionManager.getBranch()) ?? sessionManager.getLeafId();
  }

  private async findSessionPath(workspace: WorkspaceInfo, sessionId: string): Promise<string> {
    const sessionDir = workspaceSessionDir(this.config, workspace.id);
    const sessionFileSuffix = `_${sessionId}.sqlite`;
    const entries = await fs
      .readdir(sessionDir, { recursive: true, withFileTypes: true })
      .catch(() => []);
    const match = entries.find((entry) => entry.isFile() && entry.name.endsWith(sessionFileSuffix));
    if (!match) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), { statusCode: 404 });
    }
    return path.join(match.parentPath, match.name);
  }

  async openSessionById(workspace: WorkspaceInfo, sessionId: string): Promise<SessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.workspace.id === workspace.id) {
      return this.getState(existing.id, { messagesDetailLevel: "summary" });
    }
    return this.openSession(workspace, await this.findSessionPath(workspace, sessionId));
  }

  async openSessionForDelivery(
    workspace: WorkspaceInfo,
    sessionPath: string,
  ): Promise<{ state: SessionState; owned: boolean }> {
    const canonicalPath = path.resolve(sessionPath);
    const existing = [...this.sessions.values()].find(
      (candidate) => candidate.session.sessionFile === canonicalPath,
    );
    if (existing || this.sessionOpenPromises.has(canonicalPath)) {
      return { state: await this.openSession(workspace, canonicalPath), owned: false };
    }
    return { state: await this.openSession(workspace, canonicalPath), owned: true };
  }

  async openSession(
    workspace: WorkspaceInfo,
    sessionPath: string,
    messagesDetailLevel: "summary" | "full" = "summary",
  ): Promise<SessionState> {
    this.assertRunning();
    const canonicalPath = path.resolve(sessionPath);
    const existing = [...this.sessions.values()].find(
      (candidate) => candidate.session.sessionFile === canonicalPath,
    );
    if (existing) {
      return this.getState(existing.id, { messagesDetailLevel });
    }

    const pending = this.sessionOpenPromises.get(canonicalPath);
    if (pending) {
      const opened = await pending;
      return this.getState(opened.id, { messagesDetailLevel });
    }

    const opening = (async () => {
      const result = await this.createPiAgentSession(
        workspace,
        await SessionManager.open(canonicalPath),
      );
      const webSession = this.attachSession(
        workspace,
        result.session,
        result.modelFallbackMessage,
        hasSubagentSessionMarker(result.session.sessionManager.getEntries()) ||
          hasParentedCronRunSessionMarker(result.session.sessionManager.getEntries()),
      );
      return this.getState(webSession.id, { messagesDetailLevel: "summary" });
    })();
    this.sessionOpenPromises.set(canonicalPath, opening);

    try {
      const opened = await opening;
      return this.getState(opened.id, { messagesDetailLevel });
    } finally {
      if (this.sessionOpenPromises.get(canonicalPath) === opening) {
        this.sessionOpenPromises.delete(canonicalPath);
      }
    }
  }

  private cronAdapterContext(): PiServiceCronAdapterContext {
    return {
      openSession: (workspace, sessionPath) => this.openSession(workspace, sessionPath),
      createCronSession: (workspace, options) => this.createCronSession(workspace, options),
      promptCron: (sessionId, notice, operationId) =>
        this.promptCron(sessionId, notice, operationId),
      resolveOrCreateDailySession: (workspace, options) =>
        this.resolveOrCreateDailySession(workspace, options),
      requireSession: (sessionId) => this.requireSession(sessionId),
      requireSessionPath: (sessionId) => this.requireSessionPath(sessionId),
      prepareSessionForContextCopy: (sessionId, copy) =>
        this.prepareSessionForContextCopy(sessionId, copy),
      runSubagentSerial: (sessionId, run) => this.runSubagentSerial(sessionId, run),
      getState: (sessionId) => this.getState(sessionId),
      publishReset: (webSession) => this.publish(webSession),
      setThinkingLevel: (sessionId, thinkingLevel) =>
        this.setThinkingLevel(sessionId, thinkingLevel),
      setModel: (sessionId, modelId) => this.setModel(sessionId, modelId),
      onAgentCompleted: this.onAgentCompleted,
      notifyWorkspaceUpdated: (workspaceId) => this.notifyWorkspaceUpdated(workspaceId),
    };
  }

  async runCronJobSession(
    job: Parameters<typeof runCronJobSession>[1],
  ): Promise<{ sessionId: string; sessionPath: string }> {
    return runCronJobSession(this.cronAdapterContext(), job);
  }

  async deliverCronJobRun(
    job: Parameters<typeof deliverCronJobRun>[1],
    delivery: Parameters<typeof deliverCronJobRun>[2],
  ): Promise<void> {
    return deliverCronJobRun(
      {
        ...this.cronAdapterContext(),
        openSessionById: (workspace, sessionId) => this.openSessionById(workspace, sessionId),
        openSessionForDelivery: (workspace, sessionPath) =>
          this.openSessionForDelivery(workspace, sessionPath),
        disposeSession: (sessionId) => {
          const session = this.requireSession(sessionId);
          if (session.subscribers.size === 0) this.disposeWebSession(session);
        },
      },
      job,
      delivery,
    );
  }

  async deliverSkippedCronJobRun(
    job: {
      workspace: WorkspaceInfo;
      prompt: string;
      model: string;
      thinkingLevel: string;
      session: CronJobSession;
      scheduleLabel: string;
      jobId: string;
      runId: string;
    },
    skipped: { skippedAtMs: number; activeRun: RunningCronJob; reason: string },
  ): Promise<void> {
    return deliverSkippedCronJobRun(this.cronAdapterContext(), job, skipped);
  }

  async createOrOpenDailySession(workspace: WorkspaceInfo): Promise<SessionState> {
    return this.resolveOrCreateDailySession(workspace);
  }

  private async waitForSubagentQueue(sessionId: string): Promise<void> {
    await waitForSubagentQueue(this.subagentQueues, sessionId);
  }

  private appendRuntimeNotice(
    session: AgentSession,
    notice: { kind: "cron" | "subagent"; text: string },
    timestamp = Date.now(),
  ): void {
    appendRuntimeNoticeMessage(session, notice, timestamp);
  }

  private async runSubagentSerial<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    return runSubagentSerial(this.subagentQueues, sessionId, run);
  }

  private resolveSubagentDefaults(
    sessionId: string,
    ctx: ExtensionContext,
  ): {
    modelId?: string;
    thinkingLevel: string;
  } {
    return resolveSubagentDefaults(this.liveSessions.get(sessionId)?.session, ctx);
  }

  private async runDetachedSubagentSession(options: {
    sessionId?: string;
    operationId?: string;
    workspace: WorkspaceInfo;
    parentSessionId: string;
    parentSessionPath?: string;
    parentSubagentDepth: number;
    contextBranchLeafId?: string | null;
    prompt: string;
    modelId: string;
    thinkingLevel: string;
    includePreviousContext: PreviousContextMode;
    respondIn: "tool-call" | "session";
    deliveryMode?: "append" | "prompt";
    preludeNotices?: Array<{ kind: "cron" | "subagent"; text: string }>;
    currentToolCallId?: string;
    continueSession?: boolean;
    signal?: AbortSignal;
    onReady?: (details: ToolExecutionDetails) => void;
    onDelivered?: () => void;
    onUpdate?: (partial: {
      content: Array<{ type: "text"; text: string }>;
      details: ToolExecutionDetails;
    }) => void;
  }): ReturnType<typeof runDetachedSubagentSession> {
    const startedAtMs = Date.now();
    let runningSubagent: RunningSubagent | undefined;
    let releaseDelivery: (() => void) | undefined;
    const deliveryAccepted = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    this.assertRunning();
    const operation = (async () => {
      try {
        return await runDetachedSubagentSession(
          {
            createPiAgentSession: (workspace, sessionManager, createOptions) =>
              this.createPiAgentSession(workspace, sessionManager, {
                ...createOptions,
                parentSessionId: options.parentSessionId,
              }),
            attachSession: (workspace, session, modelFallbackMessage, ephemeral) =>
              this.attachSession(workspace, session, modelFallbackMessage, ephemeral),
            disposeWebSession: (webSession) => this.disposeWebSession(webSession),
            workspaceSessionDir: workspaceSessionDir(this.config, options.workspace.id),
            deliverResultToParent: async (request, result) => {
              const opened = await this.openSessionById(request.workspace, request.parentSessionId);
              if (request.deliveryMode === "prompt") {
                await deliverAsyncSubagentResult(
                  this.requireSession(opened.id).session,
                  result,
                  request.onDelivered,
                );
                return;
              }
              await this.runSubagentSerial(opened.id, async () => {
                const parent = this.requireSession(opened.id);
                if (!(await deliverDetachedSubagentResult(parent.session, result))) return;
                const state = this.getState(parent.id);
                this.publish(parent);
                await this.onAgentCompleted?.(state);
                await this.notifyWorkspaceUpdated(parent.workspace.id);
              });
            },
          },
          {
            ...options,
            onDelivered: () => {
              releaseDelivery?.();
              options.onDelivered?.();
            },
            onReady: (details) => {
              const child = (details as SubagentToolDetails).subagent;
              if (!child.sessionId || !child.sessionPath || !child.workspaceId) {
                throw new Error("Running subagent details are incomplete");
              }
              runningSubagent = {
                sessionId: child.sessionId,
                sessionPath: child.sessionPath,
                workspaceId: child.workspaceId,
                parentSessionId: options.parentSessionId,
                prompt: options.prompt,
                model: options.modelId,
                thinkingLevel: options.thinkingLevel,
                startedAtMs,
              };
              this.runningSubagents.set(child.sessionId, runningSubagent);
              this.subagentOperationAsync.set(child.sessionId, options.respondIn === "session");
              options.onReady?.(details);
            },
          },
        );
      } finally {
        if (
          runningSubagent &&
          this.runningSubagents.get(runningSubagent.sessionId) === runningSubagent
        ) {
          this.runningSubagents.delete(runningSubagent.sessionId);
        }
      }
    })();
    if (options.sessionId && !options.continueSession) {
      const settled =
        options.deliveryMode === "prompt"
          ? Promise.race([deliveryAccepted, operation]).then(
              () => {},
              () => {},
            )
          : operation.then(
              () => {},
              () => {},
            );
      this.subagentOperations.set(options.sessionId, settled);
      void settled.finally(() => {
        if (this.subagentOperations.get(options.sessionId!) === settled)
          this.subagentOperations.delete(options.sessionId!);
      });
    }
    return operation;
  }

  private startDetachedSubagentSession(options: {
    sessionId?: string;
    workspace: WorkspaceInfo;
    parentSessionId: string;
    parentSessionPath?: string;
    parentSubagentDepth: number;
    contextBranchLeafId?: string | null;
    prompt: string;
    modelId: string;
    thinkingLevel: string;
    includePreviousContext: PreviousContextMode;
    respondIn: "tool-call" | "session";
    deliveryMode?: "append" | "prompt";
    preludeNotices?: Array<{ kind: "cron" | "subagent"; text: string }>;
    currentToolCallId?: string;
  }): Promise<{ text: string; details: ToolExecutionDetails; isError: boolean }> {
    return new Promise((resolve, reject) => {
      let ready = false;
      const completion = this.runDetachedSubagentSession({
        ...options,
        onReady: (details) => {
          ready = true;
          const child = (details as SubagentToolDetails).subagent;
          resolve({
            text: [
              "Subagent started asynchronously.",
              "",
              `Session ID: ${child.sessionId}`,
              `Session: ${child.sessionPath}`,
              "Its final result will be delivered automatically.",
            ].join("\n"),
            details,
            isError: false,
          });
        },
      });
      void completion.catch((error) => {
        if (isSessionCheckpointError(error) && ready) return;
        if (!ready) {
          reject(error);
          return;
        }
        console.error("Async subagent failed after launch", {
          sessionId: options.sessionId,
          error,
        });
      });
    });
  }

  private async continueSubagent(
    workspace: WorkspaceInfo,
    parentSessionId: string,
    subagentSessionId: string,
    prompt: string,
    async: boolean,
    queued: boolean,
    signal?: AbortSignal,
  ): Promise<{ text: string; details: ToolExecutionDetails; isError: boolean }> {
    const manager = await SessionManager.existing(
      workspace.path,
      workspaceSessionDir(this.config, workspace.id),
      subagentSessionId,
    );
    if (!manager) throw new Error(`Subagent session not found: ${subagentSessionId}`);
    const marker = manager
      .getEntries()
      .findLast(
        (entry) => entry.type === "custom" && entry.customType === SUBAGENT_SESSION_CUSTOM_TYPE,
      );
    const data =
      marker?.type === "custom"
        ? (marker.data as { parentSessionId?: string; depth?: number; deliveryMode?: string })
        : undefined;
    if (data?.parentSessionId !== parentSessionId)
      throw new Error(`Subagent does not belong to this session: ${subagentSessionId}`);
    if (
      queued &&
      (this.subagentOperationAsync.get(subagentSessionId) ?? data.deliveryMode === "prompt") ===
        false
    )
      throw new Error("Only async subagents can be queued");
    const live = this.liveSessions.get(subagentSessionId)?.session;
    const modelId = live?.model ? modelKey(live.model as PiModel) : undefined;
    const parent = this.liveSessions.get(parentSessionId)?.session;
    const effectiveModel =
      modelId ?? (parent?.model ? modelKey(parent.model as PiModel) : undefined);
    if (!effectiveModel) throw new Error("No model available for subagent");

    let previous = this.subagentOperations.get(subagentSessionId);
    if (!queued && (previous || live?.isStreaming)) {
      throw new Error(
        "Subagent is still running. Use await to wait, steer to add instructions, or queue to schedule another task.",
      );
    }
    let ready!: (value: { text: string; details: ToolExecutionDetails; isError: boolean }) => void;
    let failed!: (error: unknown) => void;
    const started = new Promise<{ text: string; details: ToolExecutionDetails; isError: boolean }>(
      (resolve, reject) => {
        ready = resolve;
        failed = reject;
      },
    );
    let releaseDelivery: (() => void) | undefined;
    const deliveryAccepted = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const request = {
      sessionId: subagentSessionId,
      workspace,
      parentSessionId,
      parentSessionPath: parent?.sessionFile,
      parentSubagentDepth: data.depth! - 1,
      prompt,
      modelId: effectiveModel,
      thinkingLevel: live?.thinkingLevel ?? parent?.thinkingLevel ?? "medium",
      includePreviousContext: false as const,
      respondIn: async ? ("session" as const) : ("tool-call" as const),
      deliveryMode: async ? ("prompt" as const) : undefined,
      continueSession: true,
    };
    // A queued acknowledgement represents durable acceptance, not a process-local closure.
    const durableRequest = queued
      ? (await persistQueuedSubagentOperation(manager, request)).options
      : request;
    if (queued) previous = this.subagentOperations.get(subagentSessionId);
    const operation = (async () => {
      await previous;
      if (this.closing) throw new SessionCheckpointError();
      if (!async) signal?.throwIfAborted();
      return this.runDetachedSubagentSession({
        ...durableRequest,
        signal: async ? undefined : signal,
        onDelivered: () => releaseDelivery?.(),
        onReady: (details) => {
          const child = (details as SubagentToolDetails).subagent;
          ready({
            text: `Subagent ${queued ? "queued" : "resumed"} asynchronously.\n\nSession ID: ${child.sessionId}\nIts final result will be delivered automatically.`,
            details,
            isError: false,
          });
        },
      });
    })();
    const settled = async
      ? Promise.race([deliveryAccepted, operation]).then(
          () => {},
          () => {},
        )
      : operation.then(
          () => {},
          () => {},
        );
    this.subagentOperations.set(subagentSessionId, settled);
    void settled.finally(() => {
      if (this.subagentOperations.get(subagentSessionId) === settled)
        this.subagentOperations.delete(subagentSessionId);
    });
    if (!async) return operation;
    void operation
      .catch(async (error) => {
        if (isSessionCheckpointError(error)) return;
        failed(error);
        if (queued && previous) {
          const opened = await this.openSessionById(workspace, parentSessionId);
          await this.requireSession(opened.id).session.sendCustomMessage(
            {
              customType: "batty-runtime-notice:subagent",
              content: `Queued subagent ${subagentSessionId} failed: ${error instanceof Error ? error.message : String(error)}`,
              display: true,
            },
            { triggerTurn: true, steerWhenBusy: true },
          );
        }
      })
      .catch((error) => console.error("Failed to deliver queued subagent error", error));
    if (queued && previous) {
      void started.catch(() => {});
      return {
        text: `Subagent queued.\n\nSession ID: ${subagentSessionId}\nIts final result will be delivered automatically.`,
        details: this.subagentSessionDetails(workspace.id, subagentSessionId, manager),
        isError: false,
      };
    }
    return started;
  }

  private async awaitSubagent(
    workspace: WorkspaceInfo,
    parentSessionId: string,
    subagentSessionId: string,
  ): Promise<{ waiting: boolean; details: ToolExecutionDetails }> {
    const manager = await SessionManager.existing(
      workspace.path,
      workspaceSessionDir(this.config, workspace.id),
      subagentSessionId,
    );
    if (!manager) throw new Error(`Subagent session not found: ${subagentSessionId}`);
    const marker = manager
      .getEntries()
      .findLast(
        (entry) => entry.type === "custom" && entry.customType === SUBAGENT_SESSION_CUSTOM_TYPE,
      );
    const data =
      marker?.type === "custom"
        ? (marker.data as { parentSessionId?: string; deliveryMode?: string })
        : undefined;
    if (data?.parentSessionId !== parentSessionId)
      throw new Error(`Subagent does not belong to this session: ${subagentSessionId}`);
    if (!(this.subagentOperationAsync.get(subagentSessionId) ?? data.deliveryMode === "prompt"))
      throw new Error("Only async subagents can be awaited");
    // No async boundary between checking completion and requesting the handoff.
    // Operations include pending result admission and queued child turns.
    const pending =
      this.subagentOperations.has(subagentSessionId) ||
      this.liveSessions.get(subagentSessionId)?.session.isStreaming === true;
    if (pending) this.requireSession(parentSessionId).session.requestTurnEnd();
    return {
      waiting: pending,
      details: this.subagentSessionDetails(workspace.id, subagentSessionId, manager),
    };
  }

  private requireRunningOwnedSubagent(
    parentSessionId: string,
    subagentSessionId: string,
  ): AgentSession {
    const child = this.liveSessions.get(subagentSessionId)?.session;
    if (!child?.isStreaming) throw new Error(`Subagent is not running: ${subagentSessionId}`);
    const marker = child.sessionManager
      .getEntries()
      .findLast(
        (entry) => entry.type === "custom" && entry.customType === "batty-subagent-session",
      );
    const markerData = marker?.type === "custom" ? marker.data : undefined;
    if (
      (markerData as { parentSessionId?: string } | undefined)?.parentSessionId !== parentSessionId
    ) {
      throw new Error(`Subagent does not belong to this session: ${subagentSessionId}`);
    }
    return child;
  }

  private subagentSessionDetails(
    workspaceId: string,
    sessionId: string,
    manager: SessionManager,
  ): ToolExecutionDetails {
    return { subagent: { workspaceId, sessionId, sessionPath: manager.getSessionFile() } };
  }

  private async stopSubagent(
    workspace: WorkspaceInfo,
    parentSessionId: string,
    subagentSessionId: string,
  ): Promise<ToolExecutionDetails> {
    const child = this.requireRunningOwnedSubagent(parentSessionId, subagentSessionId);
    await child.abort();
    return this.subagentSessionDetails(workspace.id, subagentSessionId, child.sessionManager);
  }

  private async steerSubagent(
    workspace: WorkspaceInfo,
    parentSessionId: string,
    subagentSessionId: string,
    prompt: string,
  ): Promise<ToolExecutionDetails> {
    const notice = buildSubagentSteeringRuntimeNotice(prompt);
    const child = this.requireRunningOwnedSubagent(parentSessionId, subagentSessionId);
    await child.queueCustomSteeringMessage({
      customType: `batty-runtime-notice:${notice.kind}`,
      content: notice.text,
      display: true,
    });
    return this.subagentSessionDetails(workspace.id, subagentSessionId, child.sessionManager);
  }

  private async resolveOrCreateDailySession(
    workspace: WorkspaceInfo,
    options?: { modelId?: string; thinkingLevel?: string },
  ): Promise<SessionState> {
    await (await getSessionSummaryIndex(this.config)).ensureInitialized(workspace.id);
    return resolveOrCreateDailySession(
      {
        config: this.config,
        cronSessionResolutions: this.cronSessionResolutions,
        sessions: this.sessions,
        listSessionSummaries: (workspace) => this.listSessionSummaries(workspace),
        openSession: (workspace, sessionPath) => this.openSession(workspace, sessionPath),
        createSession: (workspace, createOptions) => this.createSession(workspace, createOptions),
        requireSession: (sessionId) => this.requireSession(sessionId),
        refreshBattySystemPrompt: (webSession) => this.refreshBattySystemPrompt(webSession),
        notifyWorkspaceUpdated: (workspaceId) => this.notifyWorkspaceUpdated(workspaceId),
        getState: (sessionId) => this.getState(sessionId),
      },
      workspace,
      options,
    );
  }

  private requireSessionPath(sessionId: string): string {
    const sessionPath = this.requireSession(sessionId).session.sessionFile;
    if (!sessionPath) {
      throw new Error(`Session ${sessionId} is not persisted`);
    }
    return sessionPath;
  }

  private async prepareSessionForContextCopy<T>(
    sessionId: string,
    copy: () => Promise<T>,
  ): Promise<T> {
    return this.runSubagentSerial(sessionId, async () => {
      const webSession = this.requireSession(sessionId);
      await webSession.session.waitForIdle();
      const contextUsage = getSessionContextUsage(webSession.session);
      if (contextUsage?.tokens != null) {
        const compactionSettings = webSession.session.settingsManager.getCompactionSettings();
        if (
          compactionSettings.enabled &&
          contextUsage.tokens > contextUsage.contextWindow - compactionSettings.reserveTokens
        ) {
          await webSession.session.compact(
            "Prepare this daily session for a detached cron run that includes previous context. Preserve operational facts, recent decisions, current state, scheduled work, and anything needed by future scheduled runs.",
          );
          const state = this.getState(webSession.id);
          this.publish(webSession);
          await this.onAgentCompleted?.(state);
          await this.notifyWorkspaceUpdated(webSession.workspace.id);
        }
      }
      return copy();
    });
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  listRunningSubagents(parentSessionId: string): RunningSubagent[] {
    return [...this.runningSubagents.values()]
      .filter(
        (subagent) =>
          subagent.parentSessionId === parentSessionId &&
          this.liveSessions.get(subagent.sessionId)?.session.isStreaming,
      )
      .sort((left, right) => left.startedAtMs - right.startedAtMs);
  }

  subscribe(sessionId: string, subscriber: SessionSubscriber): Promise<() => void> {
    return subscribeToSession(
      (id) => this.requireSession(id),
      (id, view, previous) => this.getSnapshot(id, view, previous),
      (session) => {
        void this.disposeWebSession(session);
      },
      sessionId,
      subscriber,
    );
  }

  getSnapshot(
    sessionId: string,
    view = this.requireSession(sessionId).session.view,
    previous?: SessionSnapshot,
  ): SessionSnapshot {
    const web = this.requireSession(sessionId);
    const store = web.session.sessionManager;
    const historyVersion = view.entries.reduce((latest, entry) => Math.max(latest, entry.id), 0);
    const sameHistory = previous?.historyVersion === historyVersion;
    const page = sameHistory
      ? undefined
      : this.getMessagePage(web, { throughEntryId: historyVersion });
    const documents = {
      "pi.live": view.docs["pi.live"] ?? {},
      "pi.inbox": view.docs["pi.inbox"] ?? { items: [] },
      "pi.agent": view.docs["pi.agent"] ?? {},
      "pi.usage": view.docs["pi.usage"] ?? { models: {}, tools: {} },
    } as SessionSnapshot["documents"];
    const ref = documents["pi.agent"].model!;
    const model = this.modelRuntime.getModel(ref.provider, ref.modelId)!;
    const contextUsage =
      sameHistory && previous.metadata.model === `${ref.provider}/${ref.modelId}`
        ? {
            tokens: previous.metadata.contextTokens,
            contextWindow: previous.metadata.contextWindow!,
            percent: previous.metadata.contextPercent,
          }
        : getViewContextUsage(view, model.contextWindow);
    const entries = sameHistory ? undefined : store.getEntriesUpTo(historyVersion);
    const queuedClientMessageIds: Record<string, string> = {};
    for (const item of documents["pi.inbox"].items) {
      const requestId = store.getSubmissionRecord(item.id)?.requestId;
      if (requestId?.startsWith("client:"))
        queuedClientMessageIds[String(item.id)] = requestId.slice(7);
    }
    return {
      metadata: {
        id: web.id,
        sessionId: web.session.sessionId,
        workspaceId: web.workspace.id,
        cwd: web.workspace.path,
        path: web.session.sessionFile,
        model: `${ref.provider}/${ref.modelId}`,
        modelLabel: `${model.name} · ${model.provider}`,
        thinkingLevel: documents["pi.agent"].thinkingLevel!,
        availableThinkingLevels: getSupportedThinkingLevels(model),
        updatedAt: sameHistory
          ? previous.metadata.updatedAt
          : (page!.messages.findLast((message) => "timestamp" in message)?.timestamp ??
            web.openedAt),
        contextTokens: contextUsage?.tokens ?? null,
        contextWindow: contextUsage?.contextWindow ?? model.contextWindow,
        contextPercent: contextUsage?.percent ?? null,
        totalMessageCount: sameHistory
          ? previous.metadata.totalMessageCount
          : page!.totalMessageCount,
        hasMoreMessages: sameHistory ? previous.metadata.hasMoreMessages : page!.hasMoreMessages,
        messagesDetailLevel: "full",
        title: web.session.sessionName,
        isSubagentSession: sameHistory
          ? previous.metadata.isSubagentSession
          : hasSubagentSessionMarker(entries!),
        isCronSession: sameHistory
          ? previous.metadata.isCronSession
          : hasParentedCronRunSessionMarker(entries!),
      },
      documents,
      queuedClientMessageIds,
      messages: sameHistory
        ? previous.messages
        : normalizeMessages(page!.messages, page!.messageIndexOffset, {
            imageResolver: web.resolveUiImage,
          }),
      historyVersion,
    };
  }

  getState(
    sessionId: string,
    options?: {
      beforeMessageId?: string;
      limit?: number;
      messagesDetailLevel?: "summary" | "full";
      throughEntryId?: number;
    },
  ): SessionState {
    const webSession = this.requireSession(sessionId);
    const contextUsage = getSessionContextUsage(webSession.session);
    const messagePage = this.getMessagePage(webSession, options);

    return createSessionState({
      id: webSession.id,

      imageResolver: webSession.resolveUiImage,
      sessionId: webSession.session.sessionId,
      workspaceId: webSession.workspace.id,
      cwd: webSession.workspace.path,
      path: webSession.session.sessionFile,
      model: webSession.session.model ? modelKey(webSession.session.model) : undefined,
      modelLabel: webSession.session.model
        ? `${webSession.session.model.name} · ${webSession.session.model.provider}`
        : undefined,
      thinkingLevel: webSession.session.thinkingLevel,
      availableThinkingLevels: webSession.session.getAvailableThinkingLevels(),
      isStreaming: !webSession.agentCompleted && webSession.session.isStreaming,
      isCompacting: webSession.session.isCompacting,
      pendingMessageCount: webSession.session.pendingMessageCount,
      queuedPrompts: getQueuedPrompts(webSession),
      updatedAt: sessionUpdatedAt(webSession.session, webSession.openedAt),
      contextTokens: contextUsage?.tokens ?? null,
      contextWindow: contextUsage?.contextWindow ?? webSession.session.model?.contextWindow ?? null,
      contextPercent: contextUsage?.percent ?? null,
      totalMessageCount: messagePage.totalMessageCount,
      hasMoreMessages: messagePage.hasMoreMessages,
      messageIndexOffset: messagePage.messageIndexOffset,
      messagesDetailLevel: options?.messagesDetailLevel ?? "full",
      messages: messagePage.messages,
      activeAssistant: webSession.session.streamingMessage,
      activeTools: webSession.session.runningTools.map((tool) => ({
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        args: tool.args as Record<string, unknown>,
        blocks: normalizeBlocks(tool.partialResult?.content ?? []),
        details: tool.partialResult?.details as ToolExecutionDetails | undefined,
        status: "running",
        isError: false,
      })),
      title: webSession.session.sessionName,
      isSubagentSession: hasSubagentSessionMarker(webSession.session.sessionManager.getEntries()),
      isCronSession: hasParentedCronRunSessionMarker(
        webSession.session.sessionManager.getEntries(),
      ),
    });
  }

  getSessionResources(sessionId: string): SessionResourcesResponse {
    const resources = this.requireSession(sessionId).session.resources;
    return {
      skills: resources.resourceLoader
        .getSkills()
        .skills.map(({ name, description, filePath }) => ({
          name,
          description,
          filePath,
        })),
      tools: resources
        .getAllTools()
        .filter((tool) => !tool.name.startsWith("mcp__") && tool.exposure !== "hidden")
        .map(({ name, description }) => ({ name, description })),
    };
  }

  getSessionMessages(
    sessionId: string,
    options?: { beforeMessageId?: string; limit?: number; throughEntryId?: number },
  ): SessionMessagesPage {
    const webSession = this.requireSession(sessionId);
    const currentTail = webSession.session.view.entries.reduce(
      (tail, entry) => Math.max(tail, entry.id),
      0,
    );
    const historyVersion = Math.min(options?.throughEntryId ?? currentTail, currentTail);
    const page = this.getMessagePage(webSession, { ...options, throughEntryId: historyVersion });
    return {
      historyVersion,
      messages: createSessionState({
        id: webSession.id,

        imageResolver: webSession.resolveUiImage,
        sessionId: webSession.session.sessionId,
        workspaceId: webSession.workspace.id,
        cwd: webSession.workspace.path,
        path: webSession.session.sessionFile,
        model: undefined,
        modelLabel: undefined,
        thinkingLevel: webSession.session.thinkingLevel,
        availableThinkingLevels: webSession.session.getAvailableThinkingLevels(),
        isStreaming: !webSession.agentCompleted && webSession.session.isStreaming,
        isCompacting: webSession.session.isCompacting,
        pendingMessageCount: webSession.session.pendingMessageCount,
        queuedPrompts: getQueuedPrompts(webSession),
        updatedAt: sessionUpdatedAt(webSession.session, webSession.openedAt),
        contextTokens: null,
        contextWindow: null,
        contextPercent: null,
        totalMessageCount: page.totalMessageCount,
        hasMoreMessages: page.hasMoreMessages,
        messageIndexOffset: page.messageIndexOffset,
        messages: page.messages,
        activeTools: [],
        title: undefined,
      }).messages,
      totalMessageCount: page.totalMessageCount,
      hasMoreMessages: page.hasMoreMessages,
    };
  }

  async setModel(sessionId: string, modelId: string): Promise<SessionState> {
    const webSession = this.requireSession(sessionId);
    const model = await this.resolveModel(modelId);
    await webSession.session.setModel(model as never);
    await this.refreshBattySystemPrompt(webSession);
    this.publish(webSession);
    return this.getState(sessionId);
  }

  async setThinkingLevel(sessionId: string, thinkingLevel: string): Promise<SessionState> {
    const webSession = this.requireSession(sessionId);
    await webSession.session.setThinkingLevel(thinkingLevel as AgentSession["thinkingLevel"]);
    await this.refreshBattySystemPrompt(webSession);
    this.publish(webSession);
    return this.getState(sessionId);
  }

  async promptCron(sessionId: string, notice: RuntimeNotice, operationId: string): Promise<void> {
    const webSession = this.requireSession(sessionId);
    await executeCronOperation(webSession.session, notice, operationId);
    if (this.hasSession(sessionId)) {
      this.publish(webSession);
    }
  }

  async prompt(
    sessionId: string,
    text: string,
    files: UploadedFile[],
    clientMessageId: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<PromptSubmissionResult> {
    this.assertRunning();
    return (async () => {
      const webSession = this.requireSession(sessionId);
      await this.waitForSubagentQueue(sessionId);
      this.assertRunning();
      const prepared = await this.preparePromptFiles(sessionId, files);
      const parts = [text.trim(), prepared.text.trim()].filter(Boolean);
      const promptText = parts.join("\n\n").trim() || "Please inspect the attached files.";
      const disposition = await webSession.session.prompt(promptText, {
        images: prepared.images,
        clientMessageId,
        ...(streamingBehavior ? { streamingBehavior } : {}),
      });
      this.publish(webSession);
      return { ...disposition, clientMessageId };
    })();
  }

  async removeQueuedPrompt(sessionId: string, submissionId: number): Promise<SessionState> {
    const webSession = this.requireSession(sessionId);
    await removeQueuedPrompt(webSession, submissionId);
    const state = this.getState(sessionId);
    this.publish(webSession);
    return state;
  }

  async abort(sessionId: string): Promise<void> {
    const webSession = this.requireSession(sessionId);
    await webSession.session.abort();
    this.publish(webSession);
  }

  private async createPiAgentSession(
    workspace: WorkspaceInfo,
    sessionManager: SessionManager,
    options?: { modelId?: string; thinkingLevel?: string; parentSessionId?: string },
  ): ReturnType<typeof createPiAgentSessionImpl> {
    const id = sessionManager.getSessionId();
    if (this.closing) {
      if (!this.sessionControllers.has(id)) await sessionManager.release();
      this.assertRunning();
    }
    for (;;) {
      const existing = this.sessionControllers.get(id);
      if (!existing) break;
      const result = await existing;
      try {
        this.assertRunning();
        const webSession = this.sessions.get(id);
        if (!result.session.isClosing && !(webSession && isWebSessionDisposing(webSession)))
          return result;
        await this.disposeWebSession(this.requireSession(id));
        this.assertRunning();
      } catch (error) {
        if (result.session.sessionManager !== sessionManager) await sessionManager.release();
        throw error;
      }
    }
    const creating = (async () => {
      const model = options?.modelId ? await this.resolveModel(options.modelId) : undefined;
      const result = await createPiAgentSessionImpl({
        config: this.config,
        workspace,
        sessionManager,
        modelRuntime: this.modelRuntime,
        model,
        thinkingLevel: options?.thinkingLevel,
        onMcpStatusChange: (status) => this.mcp.observe(id, workspace.id, status),
        customTools: createPiServiceTools(
          {
            config: this.config,
            browserService: this.browserService,
            cronService: this.cronService,
            validateModel: (modelId) => {
              this.resolveModel(modelId);
            },
            resolveSubagentDefaults: (sessionId, ctx) =>
              this.resolveSubagentDefaults(sessionId, ctx),
            runDetachedSubagentSession: (request) => this.runDetachedSubagentSession(request),
            startDetachedSubagentSession: (request) => this.startDetachedSubagentSession(request),
            awaitSubagent: (parentSessionId, subagentSessionId) =>
              this.awaitSubagent(workspace, parentSessionId, subagentSessionId),
            stopSubagent: (parentSessionId, subagentSessionId) =>
              this.stopSubagent(workspace, parentSessionId, subagentSessionId),
            steerSubagent: (parentSessionId, subagentSessionId, prompt) =>
              this.steerSubagent(workspace, parentSessionId, subagentSessionId, prompt),
            continueSubagent: (parentSessionId, subagentSessionId, prompt, async, queued, signal) =>
              this.continueSubagent(
                workspace,
                parentSessionId,
                subagentSessionId,
                prompt,
                async,
                queued,
                signal,
              ),
          },
          workspace,
        ),
      });
      return result;
    })();
    this.sessionControllers.set(id, creating);
    try {
      return await creating;
    } catch (error) {
      this.mcp.forget(id);
      this.sessionControllers.delete(id);
      sessionManager.release();
      throw error;
    }
  }

  private disposeWebSession(webSession: WebSession): Promise<void> {
    return disposeWebSession(
      this.sessions,
      (sessionId) => this.unregisterLiveSession(sessionId),
      webSession,
      () => this.browserService.closeSession(webSession.id),
    );
  }

  private attachSession(
    workspace: WorkspaceInfo,
    session: AgentSession,
    modelFallbackMessage?: string,
    ephemeral = false,
  ): WebSession {
    const existing = this.sessions.get(session.sessionId);
    if (existing) return existing;
    return attachSession(
      this.sessions,
      (workspace, session) => this.registerLiveSession(workspace, session),
      (webSession, event) => this.handleSessionEvent(webSession, event),
      workspace,
      session,
      modelFallbackMessage,
      ephemeral,
      createUiImageResolver(
        session.sessionFile,
        workspace.id,
        session.sessionId,
        this.config.baseUrl,
      ),
    );
  }

  private publish(webSession: WebSession): void {
    publish(webSession);
  }

  private getMessagePage(
    webSession: WebSession,
    options?: { beforeMessageId?: string; limit?: number; throughEntryId?: number },
  ) {
    return getSessionMessagePage(webSession.session, options);
  }

  private async handleSessionEvent(
    webSession: WebSession,
    event: SessionControllerEvent,
  ): Promise<void> {
    await handleSessionEvent(
      {
        getState: (id) => this.getState(id),
        notifyWorkspaceUpdated: (id) => this.notifyWorkspaceUpdated(id),
        disposeWebSession: (session) => {
          void this.disposeWebSession(session);
        },
        onAgentCompleted: this.onAgentCompleted,
        onAgentSettled: (settled) =>
          deliverCronFollowup(
            {
              ...this.cronAdapterContext(),
              openSessionById: (workspace, id) => this.openSessionById(workspace, id),
            },
            settled.workspace,
            settled.session,
          ),
      },
      webSession,
      event,
    );
  }

  private async notifyWorkspaceUpdated(workspaceId: string): Promise<void> {
    await this.onWorkspaceUpdated?.(workspaceId);
  }

  private async refreshBattySystemPrompt(webSession: WebSession): Promise<void> {
    await refreshBattySystemPrompt(this.config, webSession);
  }

  private resolveModel(modelId: string): PiModel {
    return resolveModel(this.modelRuntime, modelId);
  }

  private requireSession(sessionId: string): WebSession {
    return requireSession(this.sessions, sessionId);
  }

  async resolveSessionImage(workspaceId: string, sessionId: string, name: string) {
    const active = this.sessions.get(sessionId);
    if (active) {
      if (active.workspace.id !== workspaceId) {
        throw Object.assign(new Error(`Unknown session: ${sessionId}`), { statusCode: 404 });
      }
      return resolveSessionImage(active.session.sessionFile, name);
    }
    const workspace = (await listWorkspaces(this.config)).find(
      (candidate) => candidate.id === workspaceId,
    );
    if (!workspace) {
      throw Object.assign(new Error(`Unknown workspace: ${workspaceId}`), { statusCode: 404 });
    }
    return resolveSessionImage(await this.findSessionPath(workspace, sessionId), name);
  }

  private async preparePromptFiles(sessionId: string, files: UploadedFile[]) {
    return preparePromptFiles(this.config.uploadsDir, sessionId, files, this.config.baseUrl);
  }
}
