import {
  type AssistantMessage,
  type Message,
  type ToolCall,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import {
  SessionManager,
  type AgentSession,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type {
  SessionState,
  SessionSummary,
  ToolExecutionDetails,
  WorkspaceInfo,
} from "@/shared/types";
import { findBattySystemPromptSnapshot } from "./batty-system-prompt";
import {
  buildDailyCronSessionBinding,
  CRON_SESSION_CUSTOM_TYPE,
  findDailyCronSessionBinding,
  localDayStartMs,
  toLocalIsoDate,
} from "./cron-session";
import {
  buildRuntimeNoticeMessage,
  buildSubagentRuntimeNotice,
  type RuntimeNotice,
} from "./runtime-notices";
import {
  buildSubagentDetails,
  extractAssistantText,
  findLastAssistantMessage,
  hasSubagentSessionMarker,
  newlyGeneratedSubagentMessages,
  stripThinkingFromAssistantMessage,
  SUBAGENT_SESSION_CUSTOM_TYPE,
  SUBAGENT_TOOL_NAME,
  ZERO_USAGE,
} from "./subagent";
import type { PiModel, WebSession } from "./pi-service-types";
import { modelKey } from "./pi-service-types";

export function waitForSubagentQueue(
  subagentQueues: Map<string, Promise<void>>,
  sessionId: string,
) {
  return (subagentQueues.get(sessionId) ?? Promise.resolve()).catch(() => undefined);
}

export function appendRuntimeNoticeMessage(
  session: AgentSession,
  notice: RuntimeNotice,
  timestamp = Date.now(),
): void {
  appendMessages(session, [buildRuntimeNoticeMessage(notice, timestamp) as Message]);
}

export async function runSubagentSerial<T>(
  subagentQueues: Map<string, Promise<void>>,
  sessionId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = subagentQueues.get(sessionId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  subagentQueues.set(
    sessionId,
    previous.catch(() => undefined).then(() => current),
  );

  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release?.();
    if (subagentQueues.get(sessionId) === current) {
      subagentQueues.delete(sessionId);
    }
  }
}

export function resolveSubagentDefaults(
  liveSession: AgentSession | undefined,
  ctx: ExtensionContext,
): {
  modelId?: string;
  thinkingLevel: string;
} {
  const snapshot = findBattySystemPromptSnapshot(ctx.sessionManager.getEntries());

  return {
    modelId:
      liveSession?.model != null
        ? modelKey(liveSession.model as PiModel)
        : ctx.model != null
          ? modelKey(ctx.model as PiModel)
          : snapshot?.model,
    thinkingLevel: liveSession?.thinkingLevel ?? snapshot?.thinkingLevel ?? "medium",
  };
}

export interface DetachedSubagentOptions {
  workspace: WorkspaceInfo;
  parentSessionId: string;
  parentSessionPath?: string;
  contextBranchLeafId?: string | null;
  prompt: string;
  modelId: string;
  thinkingLevel: string;
  includeSessionContext: boolean;
  respondIn: "tool-call" | "session";
  preludeNotices?: RuntimeNotice[];
  currentToolCallId?: string;
  signal?: AbortSignal;
  onUpdate?: (partial: {
    content: Array<{ type: "text"; text: string }>;
    details: ToolExecutionDetails;
  }) => void;
}

export interface DetachedSubagentResult {
  text: string;
  details: ToolExecutionDetails;
  messages: AgentSession["messages"];
  generatedMessages: AgentSession["messages"];
  finalAssistant?: AssistantMessage;
  isError: boolean;
  errorMessage?: string;
}

export interface RunDetachedSubagentDeps {
  createPiAgentSession: (
    workspace: WorkspaceInfo,
    sessionManager: SessionManager,
    options?: { modelId?: string; thinkingLevel?: string },
  ) => Promise<Awaited<{ session: AgentSession }>>;
  attachSession: (
    workspace: WorkspaceInfo,
    session: AgentSession,
    modelFallbackMessage?: string,
    ephemeral?: boolean,
  ) => WebSession;
  disposeWebSession: (webSession: WebSession) => void;
  workspaceSessionDir: string;
}

function buildDetachedSubagentResult(
  subagentSession: AgentSession,
  options: DetachedSubagentOptions,
  seedMessageCount: number,
  errorOverride?: string,
): DetachedSubagentResult {
  const messages = structuredClone(subagentSession.messages) as AgentSession["messages"];
  const finalAssistant = findLastAssistantMessage(messages);
  const text =
    extractAssistantText(finalAssistant) || finalAssistant?.errorMessage || errorOverride || "";
  const generatedMessages = newlyGeneratedSubagentMessages(messages, seedMessageCount);
  const details = buildSubagentDetails(
    {
      prompt: options.prompt,
      model: options.modelId,
      effort: options.thinkingLevel,
      includeSessionContext: options.includeSessionContext,
      respondIn: options.respondIn,
    },
    messages,
    finalAssistant,
    {
      generatedMessages,
      workspaceId: options.workspace.id,
      sessionId: subagentSession.sessionId,
      sessionPath: subagentSession.sessionFile,
    },
  );
  return {
    text,
    details,
    messages,
    generatedMessages,
    finalAssistant,
    isError: finalAssistant?.stopReason === "error" || finalAssistant?.stopReason === "aborted",
    errorMessage: finalAssistant?.errorMessage || errorOverride,
  };
}

function isToolCallBlockForId(block: unknown, toolCallId: string): boolean {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "toolCall" &&
    (block as { id?: unknown }).id === toolCallId
  );
}

function resolveDetachedContextLeafId(
  sessionManager: SessionManager,
  options: Pick<DetachedSubagentOptions, "contextBranchLeafId" | "currentToolCallId">,
): string | undefined {
  if (options.contextBranchLeafId !== undefined) {
    return options.contextBranchLeafId ?? undefined;
  }

  const leafEntry = sessionManager.getLeafEntry() as
    | {
        id: string;
        parentId: string | null;
        type?: unknown;
        message?: { role?: unknown; content?: unknown };
      }
    | undefined;
  if (
    options.currentToolCallId &&
    leafEntry?.type === "message" &&
    leafEntry.message?.role === "assistant" &&
    Array.isArray(leafEntry.message.content) &&
    leafEntry.message.content.some((block) =>
      isToolCallBlockForId(block, options.currentToolCallId!),
    )
  ) {
    return leafEntry.parentId ?? undefined;
  }

  return sessionManager.getLeafId() ?? undefined;
}

function createDetachedSubagentSessionManager(
  deps: RunDetachedSubagentDeps,
  options: DetachedSubagentOptions,
): SessionManager {
  if (!options.includeSessionContext) {
    return SessionManager.create(options.workspace.path, deps.workspaceSessionDir);
  }
  if (!options.parentSessionPath) {
    throw new Error("Cannot include session context without a persisted parent session");
  }

  const sourceManager = SessionManager.open(options.parentSessionPath);
  const leafId = resolveDetachedContextLeafId(sourceManager, options);
  if (!leafId) {
    const sessionManager = SessionManager.create(options.workspace.path, deps.workspaceSessionDir);
    sessionManager.newSession({ parentSession: options.parentSessionPath });
    return sessionManager;
  }

  sourceManager.createBranchedSession(leafId);
  return sourceManager;
}

function subagentUpdateContent(
  options: Pick<DetachedSubagentOptions, "respondIn">,
  text: string,
): Array<{ type: "text"; text: string }> {
  return options.respondIn === "tool-call" && text.trim().length > 0
    ? [{ type: "text", text }]
    : [];
}

function assistantHasRenderableContent(message: AssistantMessage | undefined): boolean {
  if (!message || !Array.isArray(message.content)) {
    return false;
  }

  return message.content.some((block) => {
    if (typeof block !== "object" || block === null) {
      return false;
    }
    if (block.type === "thinking") {
      return false;
    }
    if (block.type === "text") {
      return typeof block.text === "string" && block.text.trim().length > 0;
    }
    return true;
  });
}

export async function runDetachedSubagentSession(
  deps: RunDetachedSubagentDeps,
  options: DetachedSubagentOptions,
): Promise<DetachedSubagentResult> {
  const result = await deps.createPiAgentSession(
    options.workspace,
    createDetachedSubagentSessionManager(deps, options),
    {
      modelId: options.modelId,
      thinkingLevel: options.thinkingLevel,
    },
  );
  const subagentSession = result.session;
  subagentSession.sessionManager.appendCustomEntry(SUBAGENT_SESSION_CUSTOM_TYPE, {
    parentSessionId: options.parentSessionId,
    respondIn: options.respondIn,
  });
  const webSubagentSession = deps.attachSession(
    options.workspace,
    subagentSession,
    undefined,
    true,
  );

  const subagentNotice = buildSubagentRuntimeNotice();
  const preludeNotices = options.preludeNotices ?? [];
  const initialTimestamp = Date.now();
  const preludeMessages = preludeNotices.map((notice, index) =>
    buildRuntimeNoticeMessage(notice, initialTimestamp + index),
  );
  if (preludeMessages.length > 0) {
    appendMessages(subagentSession, preludeMessages as Message[]);
  }
  const seedMessageCount = subagentSession.messages.length;

  appendRuntimeNoticeMessage(
    subagentSession,
    subagentNotice,
    initialTimestamp + preludeMessages.length,
  );
  options.onUpdate?.({
    content: [],
    details: buildSubagentDetails(
      {
        prompt: options.prompt,
        model: options.modelId,
        effort: options.thinkingLevel,
        includeSessionContext: options.includeSessionContext,
        respondIn: options.respondIn,
      },
      subagentSession.messages,
      undefined,
      {
        generatedMessages: newlyGeneratedSubagentMessages(
          subagentSession.messages,
          seedMessageCount,
        ),
        workspaceId: options.workspace.id,
        sessionId: subagentSession.sessionId,
        sessionPath: subagentSession.sessionFile,
      },
    ),
  });

  let lastText = "";
  let finalRetryError: string | undefined;
  let terminalAssistantError: string | undefined;
  let resolveFinalRetryFailure: (() => void) | undefined;
  let resolveTerminalAssistantFailure: (() => void) | undefined;
  let resolveTerminalAssistantIdleFailure: (() => void) | undefined;
  let terminalAssistantFailureTimer: NodeJS.Timeout | undefined;
  let terminalAssistantIdleFailureTimer: NodeJS.Timeout | undefined;
  const finalRetryFailure = new Promise<void>((resolve) => {
    resolveFinalRetryFailure = resolve;
  });
  const terminalAssistantFailure = new Promise<void>((resolve) => {
    resolveTerminalAssistantFailure = resolve;
  });
  const terminalAssistantIdleFailure = new Promise<void>((resolve) => {
    resolveTerminalAssistantIdleFailure = resolve;
  });
  const cancelTerminalAssistantFailure = () => {
    if (terminalAssistantFailureTimer) {
      clearTimeout(terminalAssistantFailureTimer);
      terminalAssistantFailureTimer = undefined;
    }
  };
  const scheduleTerminalAssistantFailure = () => {
    cancelTerminalAssistantFailure();
    terminalAssistantFailureTimer = setTimeout(() => {
      terminalAssistantFailureTimer = undefined;
      resolveTerminalAssistantFailure?.();
    }, 100);
  };
  const cancelTerminalAssistantIdleFailure = () => {
    if (terminalAssistantIdleFailureTimer) {
      clearInterval(terminalAssistantIdleFailureTimer);
      terminalAssistantIdleFailureTimer = undefined;
    }
  };
  const scheduleTerminalAssistantIdleFailure = () => {
    const retryState = subagentSession as AgentSession & { isRetrying?: unknown };
    if (typeof retryState.isRetrying !== "boolean") {
      return;
    }
    cancelTerminalAssistantIdleFailure();
    terminalAssistantIdleFailureTimer = setInterval(() => {
      const generatedMessages = newlyGeneratedSubagentMessages(
        subagentSession.messages,
        seedMessageCount,
      );
      const finalAssistant = findLastAssistantMessage(generatedMessages);
      if (
        !finalAssistant ||
        (finalAssistant.stopReason !== "error" && finalAssistant.stopReason !== "aborted")
      ) {
        return;
      }
      if (subagentSession.isStreaming || retryState.isRetrying) {
        return;
      }

      terminalAssistantError = extractAssistantText(finalAssistant) || finalAssistant.errorMessage;
      cancelTerminalAssistantIdleFailure();
      resolveTerminalAssistantIdleFailure?.();
    }, 250);
  };

  const unsubscribe = subagentSession.subscribe((event) => {
    if (event.type === "auto_retry_start") {
      cancelTerminalAssistantFailure();
      terminalAssistantError = undefined;
      return;
    }
    if (event.type === "auto_retry_end") {
      cancelTerminalAssistantFailure();
      if (event.success === false) {
        finalRetryError = event.finalError;
        resolveFinalRetryFailure?.();
      } else {
        terminalAssistantError = undefined;
      }
      return;
    }
    if (
      event.type !== "message_start" &&
      event.type !== "message_update" &&
      event.type !== "message_end"
    ) {
      return;
    }
    if (event.message.role !== "assistant") {
      return;
    }

    const finalAssistant = event.message as AssistantMessage;
    if (
      event.type === "message_end" &&
      (finalAssistant.stopReason === "error" || finalAssistant.stopReason === "aborted")
    ) {
      terminalAssistantError = extractAssistantText(finalAssistant) || finalAssistant.errorMessage;
      scheduleTerminalAssistantFailure();
      scheduleTerminalAssistantIdleFailure();
    }

    const text = extractAssistantText(finalAssistant);
    if (!text || text === lastText) {
      return;
    }

    lastText = text;
    options.onUpdate?.({
      content: subagentUpdateContent(options, text),
      details: buildSubagentDetails(
        {
          prompt: options.prompt,
          model: options.modelId,
          effort: options.thinkingLevel,
          includeSessionContext: options.includeSessionContext,
          respondIn: options.respondIn,
        },
        subagentSession.messages,
        finalAssistant,
        {
          generatedMessages: newlyGeneratedSubagentMessages(
            subagentSession.messages,
            seedMessageCount,
          ),
          workspaceId: options.workspace.id,
          sessionId: subagentSession.sessionId,
          sessionPath: subagentSession.sessionFile,
        },
      ),
    });
  });

  const abortListener = () => {
    void subagentSession.abort();
  };
  if (options.signal) {
    if (options.signal.aborted) {
      abortListener();
    } else {
      options.signal.addEventListener("abort", abortListener, { once: true });
    }
  }

  try {
    const promptPromise = subagentSession.prompt(options.prompt);
    void promptPromise.catch(() => undefined);
    scheduleTerminalAssistantIdleFailure();
    const completion = await Promise.race([
      promptPromise.then(() => "prompt-complete" as const),
      finalRetryFailure.then(() => "final-retry-failure" as const),
      terminalAssistantFailure.then(() => "terminal-assistant-failure" as const),
      terminalAssistantIdleFailure.then(() => "terminal-assistant-idle-failure" as const),
    ]);

    if (
      completion === "final-retry-failure" ||
      completion === "terminal-assistant-failure" ||
      completion === "terminal-assistant-idle-failure"
    ) {
      const surfacedError = finalRetryError || terminalAssistantError;
      if (completion === "terminal-assistant-failure") {
        void subagentSession.abort().catch(() => undefined);
      }
      const result = buildDetachedSubagentResult(
        subagentSession,
        options,
        seedMessageCount,
        surfacedError,
      );
      return {
        ...result,
        text:
          completion === "final-retry-failure"
            ? surfacedError || result.text || lastText || ""
            : result.text || lastText || surfacedError || "",
        isError: true,
        errorMessage:
          completion === "final-retry-failure"
            ? surfacedError || result.errorMessage
            : result.errorMessage || surfacedError,
      };
    }

    await promptPromise;
    const result = buildDetachedSubagentResult(subagentSession, options, seedMessageCount);
    return {
      ...result,
      text: result.text || lastText,
    };
  } catch (error) {
    const result = buildDetachedSubagentResult(
      subagentSession,
      options,
      seedMessageCount,
      error instanceof Error ? error.message : String(error),
    );
    return {
      ...result,
      text: result.text || lastText || (error instanceof Error ? error.message : String(error)),
      isError: true,
      errorMessage: result.errorMessage || (error instanceof Error ? error.message : String(error)),
    };
  } finally {
    cancelTerminalAssistantFailure();
    cancelTerminalAssistantIdleFailure();
    if (options.signal) {
      options.signal.removeEventListener("abort", abortListener);
    }
    unsubscribe();
    if (webSubagentSession.subscribers.size === 0 && !webSubagentSession.session.isStreaming) {
      deps.disposeWebSession(webSubagentSession);
    }
  }
}

export function appendMessages(session: AgentSession, messages: Message[]): void {
  session.agent.state.messages = [...session.messages, ...messages];
  for (const message of messages) {
    session.sessionManager.appendMessage(message);
  }
}

export function appendCronSubagentStart(
  session: AgentSession,
  toolCallId: string,
  args: {
    prompt: string;
    model: string;
    effort: string;
    includeSessionContext: boolean;
  },
  notice: RuntimeNotice,
): void {
  const timestamp = Date.now();
  appendRuntimeNoticeMessage(session, notice, timestamp);
  appendMessages(session, [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: toolCallId,
          name: SUBAGENT_TOOL_NAME,
          arguments: args,
        } satisfies ToolCall,
      ],
      api: (session.model as PiModel | undefined)?.api ?? "openai-responses",
      provider: session.model?.provider ?? "unknown",
      model: session.model?.id ?? args.model,
      usage: ZERO_USAGE,
      stopReason: "toolUse",
      timestamp: timestamp + 1,
    } satisfies AssistantMessage,
  ]);
}

export interface CronSubagentCompletionResult {
  text: string;
  details: ToolExecutionDetails;
  finalAssistant?: AssistantMessage;
  isError: boolean;
  errorMessage?: string;
}

export function appendCronSubagentCompletion(
  session: AgentSession,
  toolCallId: string,
  result: CronSubagentCompletionResult,
): void {
  const timestamp = Date.now();
  const toolResult: ToolResultMessage<ToolExecutionDetails> = {
    role: "toolResult",
    toolCallId,
    toolName: SUBAGENT_TOOL_NAME,
    content: [],
    details: result.details,
    isError: result.isError,
    timestamp,
  };
  const sanitizedFinalAssistant = stripThinkingFromAssistantMessage(result.finalAssistant);
  const deliveredAssistant: AssistantMessage =
    sanitizedFinalAssistant && assistantHasRenderableContent(sanitizedFinalAssistant)
      ? {
          ...sanitizedFinalAssistant,
          usage: ZERO_USAGE,
          timestamp: timestamp + 1,
        }
      : {
          role: "assistant",
          content: [{ type: "text", text: result.text || result.errorMessage || "(no output)" }],
          api: (session.model as PiModel | undefined)?.api ?? "openai-responses",
          provider: session.model?.provider ?? "unknown",
          model: session.model?.id ?? "unknown",
          usage: ZERO_USAGE,
          stopReason: result.isError ? "error" : "stop",
          errorMessage: result.isError ? result.errorMessage : undefined,
          timestamp: timestamp + 1,
        };
  appendMessages(session, [toolResult, deliveredAssistant]);
}

function getSubagentToolCall(
  message: AgentSession["messages"][number] | undefined,
): ToolCall | undefined {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined;
  }
  return message.content.find(
    (block): block is ToolCall =>
      typeof block === "object" &&
      block !== null &&
      block.type === "toolCall" &&
      block.name === SUBAGENT_TOOL_NAME &&
      typeof block.id === "string",
  );
}

export function findDanglingCronSubagentToolCall(
  session: AgentSession,
): { id: string; args: Record<string, unknown> } | undefined {
  const messages = session.messages;
  const lastMessage = messages.at(-1);
  const toolCall = getSubagentToolCall(lastMessage);
  if (!toolCall) {
    return undefined;
  }

  return {
    id: toolCall.id,
    args:
      typeof toolCall.arguments === "object" && toolCall.arguments !== null
        ? (toolCall.arguments as Record<string, unknown>)
        : {},
  };
}

export function buildFailedCronSubagentResult(
  args: Record<string, unknown>,
  error: unknown,
): CronSubagentCompletionResult {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  const model = typeof args.model === "string" ? args.model : "unknown";
  const effort = typeof args.effort === "string" ? args.effort : "medium";
  const includeSessionContext = args.includeSessionContext === true;
  return {
    text: errorMessage,
    details: {
      subagent: {
        prompt,
        model,
        effort,
        includeSessionContext,
        respondIn: "session",
        messageCount: 0,
        errorMessage,
      },
    },
    isError: true,
    errorMessage,
  };
}

export function appendDanglingCronSubagentFailure(session: AgentSession, error: unknown): boolean {
  const dangling = findDanglingCronSubagentToolCall(session);
  if (!dangling) {
    return false;
  }
  appendCronSubagentCompletion(
    session,
    dangling.id,
    buildFailedCronSubagentResult(dangling.args, error),
  );
  return true;
}

export interface ResolveDailySessionDeps {
  config: Pick<AppConfig, "cronDailySessionStartTime">;
  cronSessionResolutions: Map<string, Promise<SessionState>>;
  sessions: Map<string, WebSession>;
  listSessionSummaries: (workspace: WorkspaceInfo) => Promise<SessionSummary[]>;
  openSession: (workspace: WorkspaceInfo, sessionPath: string) => Promise<SessionState>;
  createSession: (
    workspace: WorkspaceInfo,
    options?: { modelId?: string; thinkingLevel?: string; ephemeral?: boolean },
  ) => Promise<SessionState>;
  requireSession: (sessionId: string) => WebSession;
  refreshBattySystemPrompt: (webSession: WebSession) => Promise<void>;
  notifyWorkspaceUpdated: (workspaceId: string) => Promise<void>;
  getState: (sessionId: string) => SessionState;
}

interface AppConfig {
  cronDailySessionStartTime: string;
}

export async function resolveOrCreateDailySession(
  deps: ResolveDailySessionDeps,
  workspace: WorkspaceInfo,
  options?: { modelId?: string; thinkingLevel?: string },
): Promise<SessionState> {
  const now = new Date();
  const date = toLocalIsoDate(now, deps.config.cronDailySessionStartTime);
  const key = `${workspace.id}:daily:${date}`;
  const inFlight = deps.cronSessionResolutions.get(key);
  if (inFlight) {
    return inFlight;
  }

  let resolution: Promise<SessionState>;
  resolution = (async () => {
    const todayStartMs = localDayStartMs(now, deps.config.cronDailySessionStartTime);
    const candidates = (await deps.listSessionSummaries(workspace)).filter(
      (candidate) =>
        typeof candidate.path === "string" &&
        candidate.path.length > 0 &&
        candidate.updatedAt >= todayStartMs,
    );

    for (const candidate of candidates) {
      const sessionPath = candidate.path;
      if (!sessionPath) {
        continue;
      }

      const loaded = [...deps.sessions.values()].find(
        (session) =>
          session.workspace.id === workspace.id && session.session.sessionFile === sessionPath,
      );
      const entries = loaded
        ? loaded.session.sessionManager.getEntries()
        : SessionManager.open(sessionPath).getEntries();
      if (hasSubagentSessionMarker(entries)) {
        continue;
      }

      if (findDailyCronSessionBinding(entries, date)) {
        return deps.openSession(workspace, sessionPath);
      }
    }

    const session = await deps.createSession(workspace, {
      ...(options?.modelId ? { modelId: options.modelId } : {}),
      ...(options?.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    });
    const webSession = deps.requireSession(session.id);
    webSession.session.sessionManager.appendCustomEntry(
      CRON_SESSION_CUSTOM_TYPE,
      buildDailyCronSessionBinding(now, deps.config.cronDailySessionStartTime),
    );
    await deps.refreshBattySystemPrompt(webSession);
    await deps.notifyWorkspaceUpdated(workspace.id);
    return deps.getState(webSession.id);
  })();

  deps.cronSessionResolutions.set(key, resolution);
  try {
    return await resolution;
  } finally {
    if (deps.cronSessionResolutions.get(key) === resolution) {
      deps.cronSessionResolutions.delete(key);
    }
  }
}
