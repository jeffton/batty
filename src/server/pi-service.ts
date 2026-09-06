import fs from "node:fs/promises";
import path from "node:path";
import {
  ModelRuntime,
  readStoredCredential,
  SessionManager,
  type AgentSession,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  CronJobSession,
  RunningCronJob,
  ModelOption,
  ProviderAuthStartResponse,
  ProviderAuthStatus,
  ServerEvent,
  SessionMessagesPage,
  SessionState,
  SessionStateMetadata,
  SessionSummary,
  ToolExecutionDetails,
  WorkspaceInfo,
} from "@/shared/types";
import type { AppConfig } from "./config";
import { ModelConfigWatcher } from "./model-config-watcher";
import { resolveModel } from "./model-resolution";
import { getSessionContextUsage } from "./pi-context-usage";
import {
  createPiAgentSession as createPiAgentSessionImpl,
  refreshBattySystemPrompt,
} from "./pi-agent-session";
import { createSessionState } from "./pi-state";
import { battyAgentDir, workspaceCronSessionDir, workspaceSessionDir } from "./pi-paths";
import { listSessionSummaries as listFastSessionSummaries } from "./session-summaries";
import { ProviderAuthService } from "./provider-auth";
import {
  hasParentedCronRunSessionMarker,
  buildCronRunSessionBinding,
  CRON_RUN_SESSION_CUSTOM_TYPE,
} from "./cron-session";
import { hasSubagentSessionMarker } from "./subagent";
import { getSessionMessagePage } from "./pi-service-message-page";
import { getQueuedPrompts, removeQueuedPrompt } from "./pi-service-queue";
import {
  createUiImageResolver,
  externalizeInlineImagesInSession,
  externalizeUploadedImagesInSession,
  preparePromptFiles,
} from "./pi-service-uploads";
import {
  attachSession,
  disposeWebSession,
  getStateMetadata,
  handleAgentEvent,
  publish,
  requireSession,
  subscribeToSession,
} from "./pi-service-sessions";
import {
  appendRuntimeNoticeMessage,
  resolveOrCreateDailySession,
  resolveSubagentDefaults,
  runDetachedSubagentSession,
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
import { deliverSkippedCronJobRun, runCronJobSession } from "./pi-service-cron-adapter";
import { createPiServiceTools } from "./pi-service-tool-factory";
import type { RuntimeNotice } from "./runtime-notices";
import { SessionReadStateStore } from "./session-read-state";
import { AgentTurnFileChangeTracker } from "./agent-turn-file-changes";
import { listWorkspaces, resolveWorkspace } from "./workspaces";
import { ActiveInteractiveTurnJournal } from "./active-interactive-turn-journal";
import { prepareInteractiveTurnRecovery, resumeInteractiveTurn } from "./interactive-turn-recovery";

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
  private readonly config: AppConfig;
  private readonly modelRuntime: ModelRuntime;
  private readonly modelConfigWatcher: ModelConfigWatcher;
  private readonly providerAuthService: ProviderAuthService;
  private readonly sessions = new Map<string, WebSession>();
  private readonly liveSessions = new Map<string, LiveSession>();
  private readonly subagentQueues = new Map<string, Promise<void>>();
  private readonly cronSessionResolutions = new Map<string, Promise<SessionState>>();
  private readonly sessionOpenPromises = new Map<string, Promise<SessionState>>();
  private readonly fileChangeTrackers = new Map<string, AgentTurnFileChangeTracker>();
  private readonly onAgentCompleted: ((session: SessionState) => Promise<void>) | undefined;
  private readonly onWorkspaceUpdated: ((workspaceId: string) => Promise<void>) | undefined;
  private readonly cronService: CronService;
  private readonly sessionReadState: SessionReadStateStore;
  private readonly activeInteractiveTurns: ActiveInteractiveTurnJournal;

  private constructor(
    config: AppConfig,
    cronService: CronService,
    modelRuntime: ModelRuntime,
    modelConfigWatcher: ModelConfigWatcher,
    sessionReadState: SessionReadStateStore,
    activeInteractiveTurns: ActiveInteractiveTurnJournal,
    onAgentCompleted?: (session: SessionState) => Promise<void>,
    onWorkspaceUpdated?: (workspaceId: string) => Promise<void>,
  ) {
    this.config = config;
    this.cronService = cronService;
    this.modelRuntime = modelRuntime;
    this.modelConfigWatcher = modelConfigWatcher;
    this.sessionReadState = sessionReadState;
    this.activeInteractiveTurns = activeInteractiveTurns;
    this.onAgentCompleted = onAgentCompleted;
    this.onWorkspaceUpdated = onWorkspaceUpdated;
    const authPath = path.join(battyAgentDir(config), "auth.json");
    this.providerAuthService = new ProviderAuthService(modelRuntime, (providerId) =>
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
    const activeInteractiveTurns = await ActiveInteractiveTurnJournal.create(config.battyDir);
    const workspaces = await listWorkspaces(config);
    const existingSessions = (
      await Promise.all(workspaces.map((workspace) => listFastSessionSummaries(config, workspace)))
    ).flat();
    await sessionReadState.initializeBaseline(existingSessions);
    return new PiService(
      config,
      cronService,
      modelRuntime,
      modelConfigWatcher,
      sessionReadState,
      activeInteractiveTurns,
      onAgentCompleted,
      onWorkspaceUpdated,
    );
  }

  async dispose(): Promise<void> {
    await this.modelConfigWatcher.dispose();
  }

  async recoverActiveInteractiveTurns(): Promise<void> {
    const entries = this.activeInteractiveTurns.list();
    if (entries.length === 0) return;

    const workspaces = await listWorkspaces(this.config);
    for (const entry of entries) {
      try {
        const workspace = resolveWorkspace(workspaces, entry.workspaceId);
        const opened = await this.openSession(workspace, entry.sessionPath);
        if (opened.sessionId !== entry.sessionId) {
          throw new Error(
            `Session id mismatch for interrupted turn: expected ${entry.sessionId}, got ${opened.sessionId}`,
          );
        }
        const webSession = this.requireSession(entry.sessionId);
        const plan = prepareInteractiveTurnRecovery(webSession.session.sessionManager.getBranch());
        if (plan.action === "complete") {
          await this.activeInteractiveTurns.deleteSession(entry.sessionId);
          continue;
        }
        console.info("Recovering interrupted interactive turn", {
          sessionId: entry.sessionId,
          workspaceId: entry.workspaceId,
        });
        void this.runRecoveredInteractiveTurn(webSession, plan).catch((error) => {
          console.error("Failed to recover interrupted interactive turn", {
            sessionId: entry.sessionId,
            workspaceId: entry.workspaceId,
            error,
          });
        });
      } catch (error) {
        console.error("Failed to prepare interrupted interactive turn recovery", {
          sessionId: entry.sessionId,
          workspaceId: entry.workspaceId,
          error,
        });
      }
    }
  }

  private async runRecoveredInteractiveTurn(
    webSession: WebSession,
    plan: Extract<ReturnType<typeof prepareInteractiveTurnRecovery>, { action: "resume" }>,
  ): Promise<void> {
    try {
      await resumeInteractiveTurn(webSession.session, plan);
    } finally {
      externalizeInlineImagesInSession(
        webSession.session,
        this.config.uploadsDir,
        this.config.baseUrl,
      );
    }
  }

  private registerLiveSession(workspace: WorkspaceInfo, session: AgentSession): void {
    this.liveSessions.set(session.sessionId, { workspace, session });
  }

  private unregisterLiveSession(sessionId: string): void {
    this.liveSessions.delete(sessionId);
  }

  getProviderAuthStatus(): ProviderAuthStatus {
    return this.providerAuthService.getStatus();
  }

  async startProviderAuth(providerId: "openai-codex"): Promise<ProviderAuthStartResponse> {
    return this.providerAuthService.start(providerId);
  }

  async completeProviderAuth(
    attemptId: string,
    callbackUrlOrCode: string,
  ): Promise<ProviderAuthStatus> {
    await this.providerAuthService.complete(attemptId, callbackUrlOrCode);
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
        (webSession.session.isStreaming ||
          [...webSession.activeTools.values()].some((tool) => tool.status === "running")),
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
    const sessionOptions = {
      ...(options?.modelId ? { modelId: options.modelId } : {}),
      ...(options?.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    };
    const result = await this.createPiAgentSession(
      workspace,
      SessionManager.create(workspace.path, workspaceSessionDir(this.config, workspace.id)),
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
      copySessionPath?: string;
    },
  ): Promise<SessionState> {
    const sessionDir = options.parentSessionId
      ? workspaceCronSessionDir(this.config, workspace.id, options.jobId, options.runId)
      : workspaceSessionDir(this.config, workspace.id);
    const sessionManager = options.copySessionPath
      ? await this.copySessionManager(
          workspace,
          sessionDir,
          options.copySessionPath,
          this.resolveCronContextCopyLeafId(options.parentSessionId, options.copySessionPath),
        )
      : SessionManager.create(workspace.path, sessionDir);
    const result = await this.createPiAgentSession(workspace, sessionManager, {
      modelId: options.modelId,
      thinkingLevel: options.thinkingLevel,
    });
    result.session.sessionManager.appendCustomEntry(
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

  private resolveCronContextCopyLeafId(
    parentSessionId: string | undefined,
    sourceSessionPath: string,
  ): string | null {
    const webSession = parentSessionId
      ? (this.sessions.get(parentSessionId) ??
        [...this.sessions.values()].find(
          (candidate) => candidate.session.sessionFile === sourceSessionPath,
        ))
      : undefined;
    const sessionManager =
      webSession?.session.sessionManager ?? SessionManager.open(sourceSessionPath);

    if (!webSession?.session.isStreaming) {
      return sessionManager.getLeafId();
    }

    return leafBeforeCurrentTurn(sessionManager.getBranch()) ?? sessionManager.getLeafId();
  }

  private async copySessionManager(
    workspace: WorkspaceInfo,
    sessionDir: string,
    sourceSessionPath: string,
    leafId: string | null,
  ): Promise<SessionManager> {
    await fs.mkdir(sessionDir, { recursive: true });
    if (!leafId) {
      const sessionManager = SessionManager.create(workspace.path, sessionDir);
      sessionManager.newSession({ parentSession: sourceSessionPath });
      return sessionManager;
    }

    const sessionManager = SessionManager.open(sourceSessionPath, sessionDir, workspace.path);
    sessionManager.createBranchedSession(leafId);
    return sessionManager;
  }

  private async findSessionPath(workspace: WorkspaceInfo, sessionId: string): Promise<string> {
    const sessionDir = workspaceSessionDir(this.config, workspace.id);
    const sessionFileSuffix = `_${sessionId}.jsonl`;
    const entries = await fs
      .readdir(sessionDir, { recursive: true, withFileTypes: true })
      .catch(() => []);
    const match = entries.find((entry) => entry.isFile() && entry.name.endsWith(sessionFileSuffix));
    if (!match) {
      throw new Error(`Session not found: ${sessionId}`);
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

  async openSession(
    workspace: WorkspaceInfo,
    sessionPath: string,
    messagesDetailLevel: "summary" | "full" = "summary",
  ): Promise<SessionState> {
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
      const result = await this.createPiAgentSession(workspace, SessionManager.open(canonicalPath));
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

  async runCronJobSession(job: {
    workspace: WorkspaceInfo;
    prompt: string;
    model: string;
    thinkingLevel: string;
    session: CronJobSession;
    scheduleLabel: string;
    jobId: string;
    runId: string;
    signal: AbortSignal;
    onSessionStarted(session: { sessionId: string; sessionPath: string }): void;
  }): Promise<{ sessionId: string; sessionPath: string }> {
    return runCronJobSession(
      {
        createCronSession: (workspace, options) => this.createCronSession(workspace, options),
        promptCron: (sessionId, notice) => this.promptCron(sessionId, notice),
        resolveOrCreateDailySession: (workspace, options) =>
          this.resolveOrCreateDailySession(workspace, options),
        requireSession: (sessionId) => this.requireSession(sessionId),
        requireSessionPath: (sessionId) => this.requireSessionPath(sessionId),
        prepareSessionForContextCopy: (sessionId) => this.prepareSessionForContextCopy(sessionId),
        runSubagentSerial: (sessionId, run) => this.runSubagentSerial(sessionId, run),
        getState: (sessionId) => this.getState(sessionId),
        publishReset: (webSession, state) => this.publish(webSession, { type: "reset", state }),
        setThinkingLevel: (sessionId, thinkingLevel) =>
          this.setThinkingLevel(sessionId, thinkingLevel),
        setModel: (sessionId, modelId) => this.setModel(sessionId, modelId),
        onAgentCompleted: this.onAgentCompleted,
        notifyWorkspaceUpdated: (workspaceId) => this.notifyWorkspaceUpdated(workspaceId),
      },
      job,
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
    return deliverSkippedCronJobRun(
      {
        createCronSession: (workspace, options) => this.createCronSession(workspace, options),
        promptCron: (sessionId, notice) => this.promptCron(sessionId, notice),
        resolveOrCreateDailySession: (workspace, options) =>
          this.resolveOrCreateDailySession(workspace, options),
        requireSession: (sessionId) => this.requireSession(sessionId),
        requireSessionPath: (sessionId) => this.requireSessionPath(sessionId),
        prepareSessionForContextCopy: (sessionId) => this.prepareSessionForContextCopy(sessionId),
        runSubagentSerial: (sessionId, run) => this.runSubagentSerial(sessionId, run),
        getState: (sessionId) => this.getState(sessionId),
        publishReset: (webSession, state) => this.publish(webSession, { type: "reset", state }),
        setThinkingLevel: (sessionId, thinkingLevel) =>
          this.setThinkingLevel(sessionId, thinkingLevel),
        setModel: (sessionId, modelId) => this.setModel(sessionId, modelId),
        onAgentCompleted: this.onAgentCompleted,
        notifyWorkspaceUpdated: (workspaceId) => this.notifyWorkspaceUpdated(workspaceId),
      },
      job,
      skipped,
    );
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
    workspace: WorkspaceInfo;
    parentSessionId: string;
    parentSessionPath?: string;
    contextBranchLeafId?: string | null;
    prompt: string;
    modelId: string;
    thinkingLevel: string;
    includeSessionContext: boolean;
    respondIn: "tool-call" | "session";
    preludeNotices?: Array<{ kind: "cron" | "subagent"; text: string }>;
    currentToolCallId?: string;
    signal?: AbortSignal;
    onUpdate?: (partial: {
      content: Array<{ type: "text"; text: string }>;
      details: ToolExecutionDetails;
    }) => void;
  }): ReturnType<typeof runDetachedSubagentSession> {
    return runDetachedSubagentSession(
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
      },
      options,
    );
  }

  private async resolveOrCreateDailySession(
    workspace: WorkspaceInfo,
    options?: { modelId?: string; thinkingLevel?: string },
  ): Promise<SessionState> {
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

  private async prepareSessionForContextCopy(sessionId: string): Promise<void> {
    await this.runSubagentSerial(sessionId, async () => {
      const webSession = this.requireSession(sessionId);
      await webSession.session.agent.waitForIdle();
      const contextUsage = getSessionContextUsage(webSession.session);
      if (contextUsage?.tokens == null) {
        return;
      }

      const compactionSettings = webSession.session.settingsManager.getCompactionSettings();
      if (
        !compactionSettings.enabled ||
        contextUsage.tokens <= contextUsage.contextWindow - compactionSettings.reserveTokens
      ) {
        return;
      }

      await webSession.session.compact(
        "Prepare this daily session for a detached cron run that includes previous context. Preserve operational facts, recent decisions, current state, scheduled work, and anything needed by future Roy heartbeats.",
      );
      const state = this.getState(webSession.id);
      this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
      await this.onAgentCompleted?.(state);
      await this.notifyWorkspaceUpdated(webSession.workspace.id);
    });
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  subscribe(
    sessionId: string,
    subscriber: SessionSubscriber,
    afterRevision?: number,
    messagesDetailLevel: "summary" | "full" = "summary",
  ): () => void {
    return subscribeToSession(
      (sessionId) => this.requireSession(sessionId),
      (sessionId, options) => this.getState(sessionId, options),
      (webSession) => this.disposeWebSession(webSession),
      sessionId,
      subscriber,
      afterRevision,
      messagesDetailLevel,
    );
  }

  getState(
    sessionId: string,
    options?: {
      beforeMessageId?: string;
      limit?: number;
      messagesDetailLevel?: "summary" | "full";
    },
  ): SessionState {
    const webSession = this.requireSession(sessionId);
    const contextUsage = getSessionContextUsage(webSession.session);
    const messagePage = this.getMessagePage(webSession, options);

    return createSessionState({
      id: webSession.id,
      revision: webSession.revision,
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
      isStreaming:
        !webSession.agentCompleted &&
        (webSession.session.isStreaming ||
          [...webSession.activeTools.values()].some((tool) => tool.status === "running")),
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
      activeAssistant: webSession.activeAssistant ?? undefined,
      activeTools: [...webSession.activeTools.values()],
      title: webSession.session.sessionName,
      isSubagentSession: hasSubagentSessionMarker(webSession.session.sessionManager.getEntries()),
      isCronSession: hasParentedCronRunSessionMarker(
        webSession.session.sessionManager.getEntries(),
      ),
    });
  }

  getSessionMessages(
    sessionId: string,
    options?: { beforeMessageId?: string; limit?: number },
  ): SessionMessagesPage {
    const webSession = this.requireSession(sessionId);
    const page = this.getMessagePage(webSession, options);
    return {
      messages: createSessionState({
        id: webSession.id,
        revision: webSession.revision,
        imageResolver: webSession.resolveUiImage,
        sessionId: webSession.session.sessionId,
        workspaceId: webSession.workspace.id,
        cwd: webSession.workspace.path,
        path: webSession.session.sessionFile,
        model: undefined,
        modelLabel: undefined,
        thinkingLevel: webSession.session.thinkingLevel,
        availableThinkingLevels: webSession.session.getAvailableThinkingLevels(),
        isStreaming:
          !webSession.agentCompleted &&
          (webSession.session.isStreaming ||
            [...webSession.activeTools.values()].some((tool) => tool.status === "running")),
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
    this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
    return this.getState(sessionId);
  }

  async setThinkingLevel(sessionId: string, thinkingLevel: string): Promise<SessionState> {
    const webSession = this.requireSession(sessionId);
    webSession.session.setThinkingLevel(thinkingLevel as AgentSession["thinkingLevel"]);
    await this.refreshBattySystemPrompt(webSession);
    this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
    return this.getState(sessionId);
  }

  async promptCron(sessionId: string, notice: RuntimeNotice): Promise<void> {
    const webSession = this.requireSession(sessionId);
    await webSession.session.sendCustomMessage(
      {
        customType: `batty-runtime-notice:${notice.kind}`,
        content: notice.text,
        display: true,
        details: undefined,
      },
      { triggerTurn: true },
    );
    if (this.hasSession(sessionId)) {
      this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
    }
  }

  async prompt(
    sessionId: string,
    text: string,
    files: UploadedFile[],
    clientMessageId: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<void> {
    const webSession = this.requireSession(sessionId);
    await this.waitForSubagentQueue(sessionId);
    const prepared = await this.preparePromptFiles(sessionId, files);
    const parts = [text.trim(), prepared.text.trim()].filter(Boolean);
    const promptText = parts.join("\n\n").trim() || "Please inspect the attached files.";
    await webSession.session.prompt(promptText, {
      images: prepared.images,
      clientMessageId,
      ...(streamingBehavior ? { streamingBehavior } : {}),
      onTurnStarted: () =>
        this.activeInteractiveTurns.set({
          workspaceId: webSession.workspace.id,
          sessionId,
          sessionPath: this.requireSessionPath(sessionId),
        }),
    });
    externalizeUploadedImagesInSession(webSession.session, prepared.uploadedImages);
    this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
  }

  async removeQueuedPrompt(
    sessionId: string,
    kind: "steer" | "followUp",
    index: number,
  ): Promise<SessionState> {
    const webSession = this.requireSession(sessionId);
    await removeQueuedPrompt(webSession, kind, index);
    const state = this.getState(sessionId);
    this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
    return state;
  }

  async abort(sessionId: string): Promise<void> {
    const webSession = this.requireSession(sessionId);
    await this.activeInteractiveTurns.deleteSession(sessionId);
    await webSession.session.abort();
    this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
  }

  private async createPiAgentSession(
    workspace: WorkspaceInfo,
    sessionManager: SessionManager,
    options?: { modelId?: string; thinkingLevel?: string; parentSessionId?: string },
  ): ReturnType<typeof createPiAgentSessionImpl> {
    const model = options?.modelId ? await this.resolveModel(options.modelId) : undefined;
    const parentTracker = options?.parentSessionId
      ? this.fileChangeTrackers.get(options.parentSessionId)
      : undefined;
    const fileChangeTracker = new AgentTurnFileChangeTracker(parentTracker?.aggregateForChild());
    const result = await createPiAgentSessionImpl({
      config: this.config,
      workspace,
      sessionManager,
      modelRuntime: this.modelRuntime,
      model,
      thinkingLevel: options?.thinkingLevel,
      fileChangeTracker,
      customTools: createPiServiceTools(
        {
          config: this.config,
          cronService: this.cronService,
          validateModel: (modelId) => {
            this.resolveModel(modelId);
          },
          resolveSubagentDefaults: (sessionId, ctx) => this.resolveSubagentDefaults(sessionId, ctx),
          runDetachedSubagentSession: (request) => this.runDetachedSubagentSession(request),
        },
        workspace,
      ),
    });
    this.fileChangeTrackers.set(result.session.sessionId, fileChangeTracker);
    return result;
  }

  private disposeWebSession(webSession: WebSession): void {
    this.fileChangeTrackers.delete(webSession.id);
    disposeWebSession(
      this.sessions,
      (sessionId) => this.unregisterLiveSession(sessionId),
      webSession,
    );
  }

  private attachSession(
    workspace: WorkspaceInfo,
    session: AgentSession,
    modelFallbackMessage?: string,
    ephemeral = false,
  ): WebSession {
    externalizeInlineImagesInSession(session, this.config.uploadsDir, this.config.baseUrl);
    return attachSession(
      this.sessions,
      (workspace, session) => this.registerLiveSession(workspace, session),
      (webSession, event) => this.handleAgentEvent(webSession, event),
      workspace,
      session,
      modelFallbackMessage,
      ephemeral,
      createUiImageResolver(this.config.uploadsDir, session.sessionId, this.config.baseUrl),
    );
  }

  private publish(webSession: WebSession, event: ServerEvent): void {
    publish(webSession, event);
  }

  private getMessagePage(
    webSession: WebSession,
    options?: { beforeMessageId?: string; limit?: number },
  ) {
    return getSessionMessagePage(webSession.session, options);
  }

  private getStateMetadata(webSession: WebSession): SessionStateMetadata {
    return getStateMetadata((sessionId, options) => this.getState(sessionId, options), webSession);
  }

  private async handleAgentEvent(webSession: WebSession, event: any): Promise<void> {
    await handleAgentEvent(
      {
        getState: (sessionId, options) => this.getState(sessionId, options),
        getStateMetadata: (webSession) => this.getStateMetadata(webSession),
        publish: (webSession, event) => this.publish(webSession, event),
        notifyWorkspaceUpdated: (workspaceId) => this.notifyWorkspaceUpdated(workspaceId),
        disposeWebSession: (webSession) => this.disposeWebSession(webSession),
        onAgentCompleted: this.onAgentCompleted,
        onAgentSettled: async (webSession) => {
          await this.activeInteractiveTurns.deleteSession(webSession.id);
        },
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

  private async preparePromptFiles(sessionId: string, files: UploadedFile[]) {
    return preparePromptFiles(this.config.uploadsDir, sessionId, files, this.config.baseUrl);
  }
}
