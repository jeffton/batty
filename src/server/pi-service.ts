import fs from "node:fs/promises";
import path from "node:path";
import {
  ModelRuntime,
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
  ProviderUsage,
  PreviousContextMode,
  ServerEvent,
  SessionMessagesPage,
  SessionState,
  SessionStateMetadata,
  SessionSummary,
  ToolExecutionDetails,
  WorkspaceInfo,
} from "@/shared/types";
import type { AppConfig } from "./config";
import { BrowserService } from "./browser-service";
import { TurnDrain } from "./turn-drain";
import { closeSharedBrowser } from "./browser-runtime";
import { ModelConfigWatcher } from "./model-config-watcher";
import { resolveModel } from "./model-resolution";
import { getSessionContextUsage } from "./pi-context-usage";
import { createSessionManagerWithPreviousContext } from "./previous-context";
import {
  createPiAgentSession as createPiAgentSessionImpl,
  refreshBattySystemPrompt,
} from "./pi-agent-session";
import { createSessionState } from "./pi-state";
import { battyAgentDir, workspaceCronSessionDir, workspaceSessionDir } from "./pi-paths";
import {
  listSessionSummaries as listFastSessionSummaries,
  getSessionSummaryIndex,
  disposeSessionSummaryIndex,
} from "./session-summaries";
import { ProviderAuthService } from "./provider-auth";
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
import { HarnessSessionStore as SessionManager } from "./harness-session-store";
import type { HarnessController as AgentSession } from "./harness-controller";
import type { Entry as SessionEntry } from "@earendil-works/pi-agent-core";

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
  readonly turns = new TurnDrain();
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
    this.providerAuthService = new ProviderAuthService(modelRuntime, (providerId) =>
      readStoredCredential(providerId, authPath),
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

  async dispose(): Promise<void> {
    await this.modelConfigWatcher.dispose();
    await Promise.all([...this.liveSessions.values()].map(({ session }) => session.dispose()));
    await this.browserService.dispose();
    await closeSharedBrowser();
    await disposeSessionSummaryIndex(this.config);
  }

  private registerLiveSession(workspace: WorkspaceInfo, session: AgentSession): void {
    this.liveSessions.set(session.sessionId, { workspace, session });
  }

  private unregisterLiveSession(sessionId: string): void {
    this.sessionControllers.delete(sessionId);
    this.liveSessions.delete(sessionId);
  }

  getProviderAuthStatus(): ProviderAuthStatus {
    return this.providerAuthService.getStatus();
  }

  async startProviderAuth(providerId: "openai-codex"): Promise<ProviderAuthStartResponse> {
    return this.providerAuthService.start(providerId);
  }

  async getProviderUsage(provider: string, model: string): Promise<ProviderUsage> {
    return this.providerUsageService.getUsage(provider, model);
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
    const sessionManager =
      webSession?.session.sessionManager ?? (await SessionManager.open(sourceSessionPath));

    if (!webSession?.session.isStreaming) {
      return sessionManager.getLeafId();
    }

    return leafBeforeCurrentTurn(sessionManager.getBranch()) ?? sessionManager.getLeafId();
  }

  private async findSessionPath(workspace: WorkspaceInfo, sessionId: string): Promise<string> {
    const sessionDir = workspaceSessionDir(this.config, workspace.id);
    const sessionFileSuffix = `_${sessionId}.jsonl`;
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
      publishReset: (webSession, state) => this.publish(webSession, { type: "reset", state }),
      setThinkingLevel: (sessionId, thinkingLevel) =>
        this.setThinkingLevel(sessionId, thinkingLevel),
      setModel: (sessionId, modelId) => this.setModel(sessionId, modelId),
      onAgentCompleted: this.onAgentCompleted,
      notifyWorkspaceUpdated: (workspaceId) => this.notifyWorkspaceUpdated(workspaceId),
    };
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
    queueResultDelivery(parentSessionId: string): Promise<void>;
  }): Promise<{ sessionId: string; sessionPath: string }> {
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
    const operation = this.turns.run(async () => {
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
                this.publish(parent, { type: "reset", state });
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
    }, true);
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

    const previous = this.subagentOperations.get(subagentSessionId);
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
    const operation = (async () => {
      await previous;
      signal?.throwIfAborted();
      return this.runDetachedSubagentSession({
        sessionId: subagentSessionId,
        workspace,
        parentSessionId,
        parentSubagentDepth: data.depth! - 1,
        prompt,
        modelId: effectiveModel,
        thinkingLevel: live?.thinkingLevel ?? parent?.thinkingLevel ?? "medium",
        includePreviousContext: false,
        respondIn: async ? "session" : "tool-call",
        deliveryMode: async ? "prompt" : undefined,
        continueSession: true,
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
        details: {},
        isError: false,
      };
    }
    return started;
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

  private async stopSubagent(parentSessionId: string, subagentSessionId: string): Promise<void> {
    await this.requireRunningOwnedSubagent(parentSessionId, subagentSessionId).abort();
  }

  private async steerSubagent(
    parentSessionId: string,
    subagentSessionId: string,
    prompt: string,
  ): Promise<void> {
    const notice = buildSubagentSteeringRuntimeNotice(prompt);
    await this.requireRunningOwnedSubagent(
      parentSessionId,
      subagentSessionId,
    ).queueCustomSteeringMessage({
      customType: `batty-runtime-notice:${notice.kind}`,
      content: notice.text,
      display: true,
    });
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
          this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
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

  subscribe(
    sessionId: string,
    subscriber: SessionSubscriber,
    afterRevision?: number,
    messagesDetailLevel: "summary" | "full" = "summary",
    afterStreamId?: string,
  ): () => void {
    return subscribeToSession(
      (sessionId) => this.requireSession(sessionId),
      (sessionId, options) => this.getState(sessionId, options),
      (webSession) => this.disposeWebSession(webSession),
      sessionId,
      subscriber,
      afterRevision,
      messagesDetailLevel,
      afterStreamId,
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
      streamId: webSession.streamId,
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
      isCompacting: Boolean(webSession.isCompacting),
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
        isCompacting: Boolean(webSession.isCompacting),
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
    await webSession.session.setThinkingLevel(thinkingLevel as AgentSession["thinkingLevel"]);
    await this.refreshBattySystemPrompt(webSession);
    this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
    return this.getState(sessionId);
  }

  async promptCron(sessionId: string, notice: RuntimeNotice, operationId: string): Promise<void> {
    const webSession = this.requireSession(sessionId);
    await executeCronOperation(webSession.session, notice, operationId);
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
    await this.turns.run(async () => {
      const webSession = this.requireSession(sessionId);
      await this.waitForSubagentQueue(sessionId);
      const prepared = await this.preparePromptFiles(sessionId, files);
      const parts = [text.trim(), prepared.text.trim()].filter(Boolean);
      const promptText = parts.join("\n\n").trim() || "Please inspect the attached files.";
      await webSession.session.prompt(promptText, {
        images: prepared.images,
        clientMessageId,
        ...(streamingBehavior ? { streamingBehavior } : {}),
      });
      this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
    });
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
    await webSession.session.abort();
    this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
  }

  private async createPiAgentSession(
    workspace: WorkspaceInfo,
    sessionManager: SessionManager,
    options?: { modelId?: string; thinkingLevel?: string; parentSessionId?: string },
  ): ReturnType<typeof createPiAgentSessionImpl> {
    const id = sessionManager.getSessionId();
    const existing = this.sessionControllers.get(id);
    if (existing) return existing;
    const creating = (async () => {
      const model = options?.modelId ? await this.resolveModel(options.modelId) : undefined;
      const result = await createPiAgentSessionImpl({
        config: this.config,
        workspace,
        sessionManager,
        modelRuntime: this.modelRuntime,
        model,
        thinkingLevel: options?.thinkingLevel,
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
            stopSubagent: (parentSessionId, subagentSessionId) =>
              this.stopSubagent(parentSessionId, subagentSessionId),
            steerSubagent: (parentSessionId, subagentSessionId, prompt) =>
              this.steerSubagent(parentSessionId, subagentSessionId, prompt),
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
      this.sessionControllers.delete(id);
      const { BACKGROUND_CONTEXT } = await import("@earendil-works/pi-agent-core");
      await sessionManager.native.close(BACKGROUND_CONTEXT);
      sessionManager.release();
      throw error;
    }
  }

  private disposeWebSession(webSession: WebSession): void {
    void this.browserService
      .closeSession(webSession.id)
      .catch((error) => console.error("Failed to close browser session", error));
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
    const existing = this.sessions.get(session.sessionId);
    if (existing) return existing;
    return attachSession(
      this.sessions,
      (workspace, session) => this.registerLiveSession(workspace, session),
      (webSession, event) => this.handleAgentEvent(webSession, event),
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
        onAgentSettled: (settled) =>
          deliverCronFollowup(
            {
              ...this.cronAdapterContext(),
              openSessionById: (workspace, sessionId) => this.openSessionById(workspace, sessionId),
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
