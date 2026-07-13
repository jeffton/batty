import { type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type AgentSession,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
  SUBAGENT_SESSION_CUSTOM_TYPE,
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
  finalAssistantOverride?: AssistantMessage,
  generatedMessagesOverride?: AgentSession["messages"],
): DetachedSubagentResult {
  const messages = structuredClone(subagentSession.messages) as AgentSession["messages"];
  const generatedMessages =
    generatedMessagesOverride ?? newlyGeneratedSubagentMessages(messages, seedMessageCount);
  const finalAssistant = finalAssistantOverride ?? findLastAssistantMessage(generatedMessages);
  const assistantError =
    finalAssistant?.stopReason === "error" || finalAssistant?.stopReason === "aborted"
      ? finalAssistant.errorMessage || "Subagent failed"
      : undefined;
  const errorMessage = errorOverride || assistantError;
  const text = errorMessage || extractAssistantText(finalAssistant) || "";
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
    isError: errorMessage !== undefined,
    errorMessage,
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
  let observedFinalAssistant: AssistantMessage | undefined;
  let lifecycleError: string | undefined;
  const observedGeneratedMessages: AgentSession["messages"] = [];

  const unsubscribe = subagentSession.subscribe((event) => {
    if (event.type === "compaction_start" && options.signal?.aborted) {
      subagentSession.abortCompaction();
      queueMicrotask(() => subagentSession.abortCompaction());
      return;
    }
    if (event.type === "auto_retry_end" && event.success === false) {
      lifecycleError = event.finalError || "Subagent retry failed";
      return;
    }
    if (event.type === "compaction_end" && event.reason === "overflow" && event.errorMessage) {
      lifecycleError = event.errorMessage;
      return;
    }
    if (
      event.type !== "message_start" &&
      event.type !== "message_update" &&
      event.type !== "message_end"
    ) {
      return;
    }
    if (event.type === "message_end") {
      observedGeneratedMessages.push(structuredClone(event.message));
    }
    if (event.message.role !== "assistant") {
      return;
    }

    const finalAssistant = event.message as AssistantMessage;
    if (event.type === "message_end") {
      observedFinalAssistant = structuredClone(finalAssistant);
      if (finalAssistant.stopReason !== "error" && finalAssistant.stopReason !== "aborted") {
        lifecycleError = undefined;
      }
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
          generatedMessages: observedGeneratedMessages,
          workspaceId: options.workspace.id,
          sessionId: subagentSession.sessionId,
          sessionPath: subagentSession.sessionFile,
        },
      ),
    });
  });

  const abortListener = () => {
    subagentSession.abortCompaction();
    void subagentSession.abort().catch(() => undefined);
  };
  if (options.signal) {
    if (options.signal.aborted) {
      abortListener();
    } else {
      options.signal.addEventListener("abort", abortListener, { once: true });
    }
  }

  try {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Subagent aborted");
    }
    await subagentSession.prompt(options.prompt);
    const result = buildDetachedSubagentResult(
      subagentSession,
      options,
      seedMessageCount,
      lifecycleError,
      observedFinalAssistant,
      observedGeneratedMessages.length > 0 ? observedGeneratedMessages : undefined,
    );
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
      observedFinalAssistant,
      observedGeneratedMessages.length > 0 ? observedGeneratedMessages : undefined,
    );
    return {
      ...result,
      text: result.text || lastText || (error instanceof Error ? error.message : String(error)),
      isError: true,
      errorMessage: result.errorMessage || (error instanceof Error ? error.message : String(error)),
    };
  } finally {
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
