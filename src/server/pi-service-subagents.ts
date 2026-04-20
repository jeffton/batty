import {
  type AssistantMessage,
  type Message,
  type ToolCall,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import {
  buildSessionContext,
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
  BATTY_RUNTIME_NOTICE_CUSTOM_TYPE,
  buildRuntimeNoticeMessage,
  buildSubagentRuntimeNotice,
  type RuntimeNotice,
} from "./runtime-notices";
import {
  buildSubagentDetails,
  cloneMessagesForSubagent,
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

function matchesPreludeNotice(
  message: AgentSession["messages"][number],
  notices: RuntimeNotice[],
): boolean {
  return notices.some(
    (notice) =>
      message.role === "custom" &&
      message.customType === `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:${notice.kind}` &&
      message.content === notice.text,
  );
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

export function sessionMessagesForSubagent(
  liveSession: AgentSession | undefined,
  attachedSession: WebSession | undefined,
  sessionId: string,
  currentToolCallId?: string,
  injectedPrompt?: string,
): AgentSession["messages"] {
  if (liveSession) {
    return cloneMessagesForSubagent(liveSession.messages, currentToolCallId, injectedPrompt);
  }

  if (attachedSession) {
    const context = buildSessionContext(
      attachedSession.session.sessionManager.getEntries(),
      attachedSession.session.sessionManager.getLeafId(),
    );
    return cloneMessagesForSubagent(
      context.messages as AgentSession["messages"],
      currentToolCallId,
      injectedPrompt,
    );
  }

  throw new Error(`Unknown live session for subagent: ${sessionId}`);
}

export interface DetachedSubagentOptions {
  workspace: WorkspaceInfo;
  parentSessionId: string;
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
  getSessionMessagesForSubagent: (
    sessionId: string,
    currentToolCallId?: string,
    injectedPrompt?: string,
  ) => AgentSession["messages"];
  workspaceSessionDir: string;
}

export async function runDetachedSubagentSession(
  deps: RunDetachedSubagentDeps,
  options: DetachedSubagentOptions,
): Promise<DetachedSubagentResult> {
  const result = await deps.createPiAgentSession(
    options.workspace,
    SessionManager.create(options.workspace.path, deps.workspaceSessionDir),
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
  const seedMessages = options.includeSessionContext
    ? deps
        .getSessionMessagesForSubagent(
          options.parentSessionId,
          options.currentToolCallId,
          options.prompt,
        )
        .filter((message) => !matchesPreludeNotice(message, preludeNotices))
    : [];
  const initialTimestamp = Date.now();
  const preludeMessages = preludeNotices.map((notice, index) =>
    buildRuntimeNoticeMessage(notice, initialTimestamp + index),
  );
  const initialMessages = [...preludeMessages, ...seedMessages] as AgentSession["messages"];
  const seedMessageCount = initialMessages.length;
  if (initialMessages.length > 0) {
    subagentSession.agent.state.messages = structuredClone(initialMessages);
    for (const message of initialMessages) {
      if (message.role === "branchSummary" || message.role === "compactionSummary") {
        continue;
      }
      subagentSession.sessionManager.appendMessage(message as Message);
    }
  }

  appendRuntimeNoticeMessage(
    subagentSession,
    subagentNotice,
    initialTimestamp + initialMessages.length,
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
  const unsubscribe = subagentSession.subscribe((event) => {
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

    const text = extractAssistantText(event.message);
    if (!text || text === lastText) {
      return;
    }

    lastText = text;
    const finalAssistant = event.message as AssistantMessage;
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
    await subagentSession.prompt(options.prompt);
    const messages = structuredClone(subagentSession.messages) as AgentSession["messages"];
    const finalAssistant = findLastAssistantMessage(messages);
    const text = extractAssistantText(finalAssistant) || lastText;
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
      errorMessage: finalAssistant?.errorMessage,
    };
  } catch (error) {
    const messages = structuredClone(subagentSession.messages) as AgentSession["messages"];
    const finalAssistant = findLastAssistantMessage(messages);
    const text =
      extractAssistantText(finalAssistant) ||
      finalAssistant?.errorMessage ||
      (error instanceof Error ? error.message : String(error));
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
      isError: true,
      errorMessage:
        finalAssistant?.errorMessage || (error instanceof Error ? error.message : String(error)),
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
    { role: "user", content: args.prompt, timestamp: timestamp + 1 },
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
      timestamp: timestamp + 2,
    } satisfies AssistantMessage,
  ]);
}

export function appendCronSubagentCompletion(
  session: AgentSession,
  toolCallId: string,
  result: {
    text: string;
    details: ToolExecutionDetails;
    finalAssistant?: AssistantMessage;
    isError: boolean;
    errorMessage?: string;
  },
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
  const deliveredAssistant: AssistantMessage = sanitizedFinalAssistant
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
