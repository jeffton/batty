import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type ExtensionContext,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type {
  CronJobSession,
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
import { getSessionContextUsage } from "./pi-context-usage";
import { createPiAgentSession, refreshBattySystemPrompt } from "./pi-agent-session";
import { buildCronRuntimeNotice } from "./runtime-notices";
import { createSessionState, normalizeBlocks } from "./pi-state";
import { battyAgentDir, workspaceSessionDir } from "./pi-paths";
import { listSessionSummaries as listFastSessionSummaries } from "./session-summaries";
import { ProviderAuthService } from "./provider-auth";
import { hasSubagentSessionMarker, SUBAGENT_TOOL_NAME } from "./subagent";
import { getSessionMessagePage } from "./pi-service-message-page";
import { preparePromptFiles } from "./pi-service-uploads";
import {
  createAttachFilesTool,
  createCronTool,
  createSubagentTool,
  createWebSearchTool,
} from "./pi-service-tools";
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
  appendCronSubagentCompletion,
  appendCronSubagentStart,
  appendRuntimeNoticeMessage,
  resolveOrCreateDailySession,
  resolveSubagentDefaults,
  runDetachedSubagentSession,
  runSubagentSerial,
  sessionMessagesForSubagent,
  waitForSubagentQueue,
} from "./pi-service-subagents";
import {
  modelKey,
  normalizeToolDetails,
  sessionUpdatedAt,
  toModelOption,
  type LiveSession,
  type PiModel,
  type SessionSubscriber,
  type UploadedFile,
  type WebSession,
} from "./pi-service-types";
import type { CronService } from "./cron";

export type { UploadedFile } from "./pi-service-types";

export class PiService {
  private readonly config: AppConfig;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly providerAuthService: ProviderAuthService;
  private readonly sessions = new Map<string, WebSession>();
  private readonly liveSessions = new Map<string, LiveSession>();
  private readonly subagentQueues = new Map<string, Promise<void>>();
  private readonly cronSessionResolutions = new Map<string, Promise<SessionState>>();
  private readonly onAgentCompleted: ((session: SessionState) => Promise<void>) | undefined;
  private readonly onWorkspaceUpdated: ((workspaceId: string) => Promise<void>) | undefined;
  private readonly cronService: CronService;

  constructor(
    config: AppConfig,
    cronService: CronService,
    onAgentCompleted?: (session: SessionState) => Promise<void>,
    onWorkspaceUpdated?: (workspaceId: string) => Promise<void>,
  ) {
    this.config = config;
    this.cronService = cronService;
    this.onAgentCompleted = onAgentCompleted;
    this.onWorkspaceUpdated = onWorkspaceUpdated;
    const agentDir = battyAgentDir(config);
    this.authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
    this.modelRegistry = ModelRegistry.create(this.authStorage, path.join(agentDir, "models.json"));
    this.providerAuthService = new ProviderAuthService(this.authStorage);
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

  setProviderApiKey(providerId: "google" | "openrouter", apiKey: string): ProviderAuthStatus {
    return this.providerAuthService.setApiKey(providerId, apiKey);
  }

  async listModels(): Promise<ModelOption[]> {
    this.modelRegistry.refresh();
    const models = await this.modelRegistry.getAvailable();
    return models.map(toModelOption).sort((a, b) => a.label.localeCompare(b.label));
  }

  async listSessionSummaries(workspace: WorkspaceInfo): Promise<SessionSummary[]> {
    return listFastSessionSummaries(this.config, workspace);
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

  async openSession(workspace: WorkspaceInfo, sessionPath: string): Promise<SessionState> {
    const existing = [...this.sessions.values()].find(
      (candidate) => candidate.session.sessionFile === sessionPath,
    );
    if (existing) {
      return this.getState(existing.id);
    }

    const result = await this.createPiAgentSession(workspace, SessionManager.open(sessionPath));
    const webSession = this.attachSession(
      workspace,
      result.session,
      result.modelFallbackMessage,
      hasSubagentSessionMarker(result.session.sessionManager.getEntries()),
    );
    return this.getState(webSession.id);
  }

  async runCronJobSession(job: {
    workspace: WorkspaceInfo;
    prompt: string;
    model: string;
    thinkingLevel: string;
    session: CronJobSession;
    scheduleLabel: string;
  }): Promise<{ sessionId: string; sessionPath: string }> {
    const cronNotice = buildCronRuntimeNotice(job.scheduleLabel);
    if (job.session.kind === "new") {
      const session = await this.createSession(job.workspace, {
        modelId: job.model,
        thinkingLevel: job.thinkingLevel,
      });
      const current = this.requireSession(session.id);
      this.appendRuntimeNotice(current.session, cronNotice);
      await this.prompt(
        session.id,
        job.prompt,
        [],
        current.session.isStreaming ? "followUp" : undefined,
      );

      return {
        sessionId: current.session.sessionId,
        sessionPath: this.requireSessionPath(session.id),
      };
    }

    const session = await this.resolveOrCreateDailySession(job.workspace, {
      modelId: job.model,
      thinkingLevel: job.thinkingLevel,
    });
    const webSession = this.requireSession(session.id);

    return this.runSubagentSerial(webSession.session.sessionId, async () => {
      await webSession.session.agent.waitForIdle();
      this.setThinkingLevel(session.id, job.thinkingLevel);
      await this.setModel(session.id, job.model);

      if (job.session.kind === "daily-inline") {
        this.appendRuntimeNotice(webSession.session, cronNotice);
        this.publish(webSession, { type: "reset", state: this.getState(webSession.id) });
        await webSession.session.prompt(job.prompt);
        return {
          sessionId: webSession.session.sessionId,
          sessionPath: this.requireSessionPath(webSession.id),
        };
      }
      if (job.session.kind !== "daily-subagent") {
        throw new Error(`Invalid cron session kind: ${job.session.kind}`);
      }

      const includePreviousContext = job.session.includePreviousContext === true;
      const toolCallId = `${SUBAGENT_TOOL_NAME}-${randomUUID()}`;
      const toolArgs = {
        prompt: job.prompt,
        model: job.model,
        effort: job.thinkingLevel,
        includeSessionContext: includePreviousContext,
      };

      this.appendCronSubagentStart(webSession.session, toolCallId, toolArgs, cronNotice);
      webSession.activeTools.set(toolCallId, {
        toolCallId,
        toolName: SUBAGENT_TOOL_NAME,
        args: toolArgs,
        blocks: [],
        status: "running",
        isError: false,
        details: undefined,
      });
      this.publish(webSession, { type: "reset", state: this.getState(webSession.id) });

      try {
        const result = await this.runDetachedSubagentSession({
          workspace: job.workspace,
          parentSessionId: webSession.session.sessionId,
          prompt: job.prompt,
          modelId: job.model,
          thinkingLevel: job.thinkingLevel,
          includeSessionContext: includePreviousContext,
          respondIn: "session",
          preludeNotices: [cronNotice],
          currentToolCallId: toolCallId,
          onUpdate: (partial) => {
            const current = webSession.activeTools.get(toolCallId);
            if (!current) {
              return;
            }
            current.blocks = normalizeBlocks(partial.content ?? []);
            current.details = normalizeToolDetails(partial.details);
            webSession.activeTools.set(toolCallId, current);
            this.publish(webSession, {
              type: "tools",
              tools: [...webSession.activeTools.values()],
            });
          },
        });

        this.appendCronSubagentCompletion(webSession.session, toolCallId, result);
        const completedState = this.getState(webSession.id);
        this.publish(webSession, { type: "reset", state: completedState });
        try {
          await this.onAgentCompleted?.({
            ...completedState,
            isStreaming: false,
            pendingMessageCount: 0,
            activeAssistant: undefined,
          });
        } catch (error) {
          console.error("Failed to run agent completion hook for cron subagent", error);
        }
        await this.notifyWorkspaceUpdated(job.workspace.id);

        if (result.isError) {
          throw new Error(result.errorMessage || result.text || "Subagent failed");
        }

        return {
          sessionId: webSession.session.sessionId,
          sessionPath: this.requireSessionPath(webSession.id),
        };
      } finally {
        webSession.activeTools.delete(toolCallId);
        this.publish(webSession, { type: "tools", tools: [...webSession.activeTools.values()] });
      }
    });
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

  private sessionMessagesForSubagent(
    sessionId: string,
    currentToolCallId?: string,
    injectedPrompt?: string,
  ): AgentSession["messages"] {
    return sessionMessagesForSubagent(
      this.liveSessions.get(sessionId)?.session,
      this.sessions.get(sessionId),
      sessionId,
      currentToolCallId,
      injectedPrompt,
    );
  }

  private async runDetachedSubagentSession(options: {
    workspace: WorkspaceInfo;
    parentSessionId: string;
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
  }) {
    return runDetachedSubagentSession(
      {
        createPiAgentSession: (workspace, sessionManager, createOptions) =>
          this.createPiAgentSession(workspace, sessionManager, createOptions),
        attachSession: (workspace, session, modelFallbackMessage, ephemeral) =>
          this.attachSession(workspace, session, modelFallbackMessage, ephemeral),
        disposeWebSession: (webSession) => this.disposeWebSession(webSession),
        getSessionMessagesForSubagent: (sessionId, currentToolCallId, injectedPrompt) =>
          this.sessionMessagesForSubagent(sessionId, currentToolCallId, injectedPrompt),
        workspaceSessionDir: workspaceSessionDir(this.config, options.workspace.id),
      },
      options,
    );
  }

  private appendCronSubagentStart(
    session: AgentSession,
    toolCallId: string,
    args: {
      prompt: string;
      model: string;
      effort: string;
      includeSessionContext: boolean;
    },
    notice: { kind: "cron" | "subagent"; text: string },
  ): void {
    appendCronSubagentStart(session, toolCallId, args, notice);
  }

  private appendCronSubagentCompletion(
    session: AgentSession,
    toolCallId: string,
    result: {
      text: string;
      details: ToolExecutionDetails;
      finalAssistant?: any;
      isError: boolean;
      errorMessage?: string;
    },
  ): void {
    appendCronSubagentCompletion(session, toolCallId, result);
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

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  subscribe(sessionId: string, subscriber: SessionSubscriber): () => void {
    return subscribeToSession(
      (sessionId) => this.requireSession(sessionId),
      (sessionId, options) => this.getState(sessionId, options),
      (webSession) => this.disposeWebSession(webSession),
      sessionId,
      subscriber,
    );
  }

  getState(
    sessionId: string,
    options?: { beforeMessageId?: string; limit?: number },
  ): SessionState {
    const webSession = this.requireSession(sessionId);
    const contextUsage = getSessionContextUsage(webSession.session);
    const messagePage = this.getMessagePage(webSession, options);

    return createSessionState({
      id: webSession.id,
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
      isStreaming: webSession.session.isStreaming,
      pendingMessageCount: webSession.session.pendingMessageCount,
      updatedAt: sessionUpdatedAt(webSession.session, webSession.openedAt),
      contextTokens: contextUsage?.tokens ?? null,
      contextWindow: contextUsage?.contextWindow ?? webSession.session.model?.contextWindow ?? null,
      contextPercent: contextUsage?.percent ?? null,
      totalMessageCount: messagePage.totalMessageCount,
      hasMoreMessages: messagePage.hasMoreMessages,
      messageIndexOffset: messagePage.messageIndexOffset,
      messages: messagePage.messages,
      activeAssistant: webSession.activeAssistant ?? undefined,
      activeTools: [...webSession.activeTools.values()],
      title: webSession.session.sessionName,
      isSubagentSession: hasSubagentSessionMarker(webSession.session.sessionManager.getEntries()),
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
        sessionId: webSession.session.sessionId,
        workspaceId: webSession.workspace.id,
        cwd: webSession.workspace.path,
        path: webSession.session.sessionFile,
        model: undefined,
        modelLabel: undefined,
        thinkingLevel: webSession.session.thinkingLevel,
        availableThinkingLevels: webSession.session.getAvailableThinkingLevels(),
        isStreaming: webSession.session.isStreaming,
        pendingMessageCount: webSession.session.pendingMessageCount,
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

  setThinkingLevel(sessionId: string, thinkingLevel: string): SessionState {
    const webSession = this.requireSession(sessionId);
    webSession.session.setThinkingLevel(thinkingLevel as AgentSession["thinkingLevel"]);
    this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
    return this.getState(sessionId);
  }

  async prompt(
    sessionId: string,
    text: string,
    files: UploadedFile[],
    streamingBehavior?: "steer" | "followUp",
  ): Promise<void> {
    const webSession = this.requireSession(sessionId);
    await this.waitForSubagentQueue(sessionId);
    const prepared = await this.preparePromptFiles(sessionId, files);
    const parts = [text.trim(), prepared.text.trim()].filter(Boolean);
    const promptText = parts.join("\n\n").trim() || "Please inspect the attached files.";

    await webSession.session.prompt(promptText, {
      images: prepared.images,
      ...(streamingBehavior ? { streamingBehavior } : {}),
    });
  }

  async abort(sessionId: string): Promise<void> {
    const webSession = this.requireSession(sessionId);
    await webSession.session.abort();
    this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
  }

  private async createPiAgentSession(
    workspace: WorkspaceInfo,
    sessionManager: SessionManager,
    options?: { modelId?: string; thinkingLevel?: string },
  ) {
    const model = options?.modelId ? await this.resolveModel(options.modelId) : undefined;
    return createPiAgentSession({
      config: this.config,
      workspace,
      sessionManager,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model,
      thinkingLevel: options?.thinkingLevel,
      customTools: [
        this.createSubagentTool(workspace),
        this.createCronTool(workspace),
        this.createWebSearchTool(),
        this.createAttachFilesTool(workspace),
      ],
    });
  }

  private disposeWebSession(webSession: WebSession): void {
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
    return attachSession(
      this.sessions,
      (workspace, session) => this.registerLiveSession(workspace, session),
      (webSession, event) => this.handleAgentEvent(webSession, event),
      workspace,
      session,
      modelFallbackMessage,
      ephemeral,
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

  private createSubagentTool(workspace: WorkspaceInfo): ToolDefinition<any> {
    return createSubagentTool({
      workspace,
      config: this.config,
      resolveSubagentDefaults: (sessionId, ctx) => this.resolveSubagentDefaults(sessionId, ctx),
      runSubagentSerial: (sessionId, run) => this.runSubagentSerial(sessionId, run),
      runDetachedSubagentSession: (request) => this.runDetachedSubagentSession(request),
    });
  }

  private createCronTool(workspace: WorkspaceInfo): ToolDefinition<any> {
    return createCronTool({
      workspace,
      cronService: this.cronService,
      resolveSubagentDefaults: (sessionId, ctx) => this.resolveSubagentDefaults(sessionId, ctx),
    });
  }

  private createWebSearchTool(): ToolDefinition<any> {
    return createWebSearchTool(this.config);
  }

  private createAttachFilesTool(workspace: WorkspaceInfo): ToolDefinition<any> {
    return createAttachFilesTool({
      workspace,
      config: this.config,
    });
  }

  private async resolveModel(modelId: string): Promise<PiModel> {
    const [provider, ...rest] = modelId.split("/");
    if (!provider || rest.length === 0) {
      throw new Error(`Invalid model id: ${modelId}`);
    }

    const resolved = this.modelRegistry.find(provider, rest.join("/"));
    if (!resolved) {
      throw new Error(`Model not found: ${modelId}`);
    }

    return resolved;
  }

  private requireSession(sessionId: string): WebSession {
    return requireSession(this.sessions, sessionId);
  }

  private async preparePromptFiles(
    sessionId: string,
    files: UploadedFile[],
  ): Promise<{ text: string; images: Array<{ type: "image"; mimeType: string; data: string }> }> {
    return preparePromptFiles(this.config.uploadsDir, sessionId, files);
  }
}
