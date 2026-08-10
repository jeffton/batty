import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  ServerEvent,
  SessionState,
  SessionStateMetadata,
  WorkspaceInfo,
} from "@/shared/types";
import { normalizeBlocks, normalizeMessage, type UiImageResolver } from "./pi-state";
import { sanitizeTerminalBlocks } from "./terminal-output";
import type { SessionSubscriber, WebSession } from "./pi-service-types";
import { normalizeToolDetails } from "./pi-service-types";

export function disposeWebSession(
  sessions: Map<string, WebSession>,
  unregisterLiveSession: (sessionId: string) => void,
  webSession: WebSession,
): void {
  sessions.delete(webSession.id);
  unregisterLiveSession(webSession.id);
  webSession.session.dispose();
}

export function attachSession(
  sessions: Map<string, WebSession>,
  registerLiveSession: (workspace: WorkspaceInfo, session: AgentSession) => void,
  handleAgentEvent: (webSession: WebSession, event: AgentSessionEvent) => Promise<void>,
  workspace: WorkspaceInfo,
  session: AgentSession,
  modelFallbackMessage?: string,
  ephemeral = false,
  resolveUiImage?: UiImageResolver,
): WebSession {
  const webSession: WebSession = {
    id: session.sessionId,
    workspace,
    session,
    subscribers: new Set(),
    activeTools: new Map(),
    openedAt: Date.now(),
    modelFallbackMessage,
    ephemeral,
    revision: 0,
    eventLog: [],
    resolveUiImage,
  };

  session.subscribe((event) => {
    void handleAgentEvent(webSession, event).catch((error) => {
      console.error("Failed to handle agent event", error);
    });
  });
  sessions.set(webSession.id, webSession);
  registerLiveSession(workspace, session);
  return webSession;
}

const MAX_REPLAY_EVENTS = 500;

function withRevision(event: ServerEvent, revision: number): ServerEvent {
  if (event.type === "reset") {
    return { ...event, revision, state: { ...event.state, revision } };
  }
  if (event.type === "state") {
    return { ...event, revision, state: { ...event.state, revision } };
  }
  return { ...event, revision };
}

export function publish(webSession: WebSession, event: ServerEvent): void {
  const revision = (webSession.revision ?? 0) + 1;
  webSession.revision = revision;
  const versionedEvent = withRevision(event, revision);
  const eventLog = (webSession.eventLog ??= []);
  if (versionedEvent.type === "reset") {
    eventLog.length = 0;
  }
  eventLog.push({ revision, event: structuredClone(versionedEvent) });
  if (eventLog.length > MAX_REPLAY_EVENTS) {
    eventLog.splice(0, eventLog.length - MAX_REPLAY_EVENTS);
  }

  for (const subscriber of webSession.subscribers) {
    subscriber(versionedEvent, revision);
  }
}

export function getStateMetadata(
  getState: (
    sessionId: string,
    options?: { beforeMessageId?: string; limit?: number },
  ) => SessionState,
  webSession: WebSession,
): SessionStateMetadata {
  const state = getState(webSession.id, { limit: 1 });
  const {
    messages: _messages,
    activeAssistant: _activeAssistant,
    activeTools: _activeTools,
    ...rest
  } = state;
  return rest;
}

function hasToolCallInBlocks(blocks: ReturnType<typeof normalizeBlocks>): boolean {
  return blocks.some((block) => block.type === "toolCall");
}

function appendOnlyBlockDeltas(
  previous: ReturnType<typeof normalizeBlocks>,
  next: ReturnType<typeof normalizeBlocks>,
):
  | Array<{
      contentIndex: number;
      blockType: "text" | "thinking";
      delta: string;
    }>
  | undefined {
  if (previous.length !== next.length) {
    return undefined;
  }

  const deltas: Array<{
    contentIndex: number;
    blockType: "text" | "thinking";
    delta: string;
  }> = [];
  for (let contentIndex = 0; contentIndex < next.length; contentIndex += 1) {
    const previousBlock = previous[contentIndex]!;
    const nextBlock = next[contentIndex]!;
    if (previousBlock.type === "text" && nextBlock.type === "text") {
      if (!nextBlock.text.startsWith(previousBlock.text)) {
        return undefined;
      }
      const delta = nextBlock.text.slice(previousBlock.text.length);
      if (delta) {
        deltas.push({ contentIndex, blockType: "text", delta });
      }
      continue;
    }
    if (previousBlock.type === "thinking" && nextBlock.type === "thinking") {
      if (!nextBlock.thinking.startsWith(previousBlock.thinking)) {
        return undefined;
      }
      const delta = nextBlock.thinking.slice(previousBlock.thinking.length);
      if (delta) {
        deltas.push({ contentIndex, blockType: "thinking", delta });
      }
      continue;
    }
    if (JSON.stringify(previousBlock) !== JSON.stringify(nextBlock)) {
      return undefined;
    }
  }
  return deltas;
}

async function waitForSessionStateFlush(): Promise<void> {
  // `message_end` can arrive before the session manager's branch view reflects
  // the finished message. Yield once so the reset snapshot includes the new
  // user message instead of forcing the client to rediscover it later.
  await Promise.resolve();
}

async function runCompletionHook(
  deps: {
    notifyWorkspaceUpdated: (workspaceId: string) => Promise<void>;
    onAgentCompleted?: (session: SessionState) => Promise<void>;
    disposeWebSession: (webSession: WebSession) => void;
  },
  webSession: WebSession,
  session: SessionState,
): Promise<void> {
  try {
    console.info("Running agent completion hook", {
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
    });
    await deps.onAgentCompleted?.(session);
  } catch (error) {
    console.error("Failed to run agent completion hook", error);
  }
  try {
    await deps.notifyWorkspaceUpdated(session.workspaceId);
  } catch (error) {
    console.error("Failed to publish workspace update", error);
  }
  if (webSession.ephemeral && webSession.subscribers.size === 0) {
    deps.disposeWebSession(webSession);
  }
}

function hasToolCallMessage(messages: SessionState["messages"], toolCallIds: string[]): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.blocks.some((block) => block.type === "toolCall" && toolCallIds.includes(block.id)),
  );
}

export async function handleAgentEvent(
  deps: {
    getState: (
      sessionId: string,
      options?: { beforeMessageId?: string; limit?: number },
    ) => SessionState;
    getStateMetadata: (webSession: WebSession) => SessionStateMetadata;
    publish: (webSession: WebSession, event: ServerEvent) => void;
    notifyWorkspaceUpdated: (workspaceId: string) => Promise<void>;
    disposeWebSession: (webSession: WebSession) => void;
    onAgentCompleted?: (session: SessionState) => Promise<void>;
  },
  webSession: WebSession,
  event: AgentSessionEvent,
): Promise<void> {
  switch (event.type) {
    case "message_start":
      if (event.message.role === "assistant") {
        webSession.activeAssistant = event.message;
        deps.publish(webSession, {
          type: "assistant",
          assistant: normalizeMessage(event.message, Number.MAX_SAFE_INTEGER, {
            imageResolver: webSession.resolveUiImage,
          }) as Extract<SessionState["messages"][number], { role: "assistant" }>,
        });
      }
      break;
    case "message_update":
      if (event.message.role === "assistant") {
        webSession.activeAssistant = event.message;
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta" || update.type === "thinking_delta") {
          deps.publish(webSession, {
            type: "assistant-delta",
            contentIndex: update.contentIndex,
            blockType: update.type === "text_delta" ? "text" : "thinking",
            delta: update.delta,
          });
        } else if (
          update.type === "toolcall_start" ||
          update.type === "toolcall_delta" ||
          update.type === "toolcall_end" ||
          update.type === "error"
        ) {
          deps.publish(webSession, {
            type: "assistant",
            assistant: normalizeMessage(event.message, Number.MAX_SAFE_INTEGER, {
              imageResolver: webSession.resolveUiImage,
            }) as Extract<SessionState["messages"][number], { role: "assistant" }>,
          });
        }
      }
      break;
    case "message_end":
      if (event.message.role === "assistant") {
        const blocks = normalizeBlocks(event.message.content, {
          imageResolver: webSession.resolveUiImage,
        });
        if (hasToolCallInBlocks(blocks)) {
          const toolCallIds = blocks.flatMap((block) =>
            block.type === "toolCall" ? [block.id] : [],
          );
          const state = deps.getState(webSession.id);
          if (hasToolCallMessage(state.messages, toolCallIds)) {
            webSession.activeAssistant = undefined;
            deps.publish(webSession, { type: "reset", state: deps.getState(webSession.id) });
          } else {
            deps.publish(webSession, { type: "reset", state });
          }
          break;
        }

        webSession.activeAssistant = undefined;
      }
      await waitForSessionStateFlush();
      if (event.message.role === "toolResult") {
        webSession.activeTools.delete(event.message.toolCallId);
      }
      deps.publish(webSession, { type: "reset", state: deps.getState(webSession.id) });
      break;
    case "tool_execution_start":
      webSession.activeTools.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args as Record<string, unknown>,
        blocks: [],
        status: "running",
        isError: false,
        details: undefined,
      });
      deps.publish(webSession, {
        type: "tools",
        tools: [webSession.activeTools.get(event.toolCallId)!],
      });
      break;
    case "tool_execution_update": {
      const current = webSession.activeTools.get(event.toolCallId);
      if (current) {
        const normalizedBlocks = normalizeBlocks(event.partialResult.content ?? [], {
          imageResolver: webSession.resolveUiImage,
        });
        const blocks =
          current.toolName === "bash" ? sanitizeTerminalBlocks(normalizedBlocks) : normalizedBlocks;
        const details = normalizeToolDetails(event.partialResult.details);
        const deltas = appendOnlyBlockDeltas(current.blocks, blocks);
        const next = { ...current, blocks, details };
        webSession.activeTools.set(event.toolCallId, next);
        if (deltas) {
          deps.publish(webSession, {
            type: "tool-delta",
            toolCallId: event.toolCallId,
            deltas,
            details,
          });
        } else {
          deps.publish(webSession, { type: "tools", tools: [next] });
        }
      }
      break;
    }
    case "tool_execution_end": {
      const current = webSession.activeTools.get(event.toolCallId);
      if (current) {
        const blocks = normalizeBlocks(event.result.content ?? [], {
          imageResolver: webSession.resolveUiImage,
        });
        current.blocks = current.toolName === "bash" ? sanitizeTerminalBlocks(blocks) : blocks;
        current.status = event.isError ? "error" : "success";
        current.isError = event.isError;
        current.details = normalizeToolDetails(event.result.details);
        webSession.activeTools.set(event.toolCallId, current);
        deps.publish(webSession, { type: "tools", tools: [current] });
      }
      break;
    }
    case "agent_start":
      webSession.activeTools.clear();
      webSession.agentCompleted = false;
      webSession.suppressNextAgentEndCompletion = false;
      deps.publish(webSession, { type: "tools", tools: [] });
      deps.publish(webSession, { type: "state", state: deps.getStateMetadata(webSession) });
      break;
    case "auto_retry_start":
      webSession.autoRetryActive = true;
      break;
    case "agent_end":
    case "turn_end":
    case "compaction_end":
    case "auto_retry_end": {
      const agentEndWillRetry = event.type === "agent_end" && event.willRetry;
      if (agentEndWillRetry) {
        webSession.autoRetryActive = true;
      }
      if (event.type === "agent_end") {
        webSession.activeAssistant = undefined;
        if (!agentEndWillRetry && !webSession.autoRetryActive) {
          webSession.agentCompleted = true;
          webSession.activeTools.clear();
        }
      }
      if (event.type === "auto_retry_end") {
        webSession.autoRetryActive = false;
        if (!event.success) {
          webSession.agentCompleted = true;
          webSession.activeTools.clear();
        }
      }
      const state = deps.getState(webSession.id);
      const publishedState = webSession.agentCompleted
        ? {
            ...state,
            isStreaming: false,
            pendingMessageCount: 0,
            activeAssistant: undefined,
            activeTools: [],
          }
        : state;
      deps.publish(webSession, { type: "reset", state: publishedState });

      if (event.type === "auto_retry_end") {
        if (!event.success) {
          webSession.suppressNextAgentEndCompletion = true;
          await runCompletionHook(deps, webSession, publishedState);
        }
        break;
      }

      if (event.type === "agent_end") {
        if (webSession.suppressNextAgentEndCompletion) {
          webSession.suppressNextAgentEndCompletion = false;
          break;
        }
        if (!agentEndWillRetry && !webSession.autoRetryActive) {
          await runCompletionHook(deps, webSession, publishedState);
        }
      }
      break;
    }
    default:
      break;
  }
}

export function requireSession(sessions: Map<string, WebSession>, sessionId: string): WebSession {
  const webSession = sessions.get(sessionId);
  if (!webSession) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  return webSession;
}

export function subscribeToSession(
  requireSession: (sessionId: string) => WebSession,
  getState: (
    sessionId: string,
    options?: { beforeMessageId?: string; limit?: number },
  ) => SessionState,
  disposeWebSession: (webSession: WebSession) => void,
  sessionId: string,
  subscriber: SessionSubscriber,
  afterRevision?: number,
): () => void {
  const webSession = requireSession(sessionId);
  webSession.subscribers.add(subscriber);

  const currentRevision = webSession.revision ?? 0;
  if (afterRevision === undefined) {
    subscriber(
      withRevision({ type: "reset", state: getState(sessionId) }, currentRevision),
      currentRevision,
    );
  } else if (afterRevision !== currentRevision) {
    const replay = (webSession.eventLog ?? []).filter((entry) => entry.revision > afterRevision);
    const firstReplay = replay[0];
    const canReplay =
      afterRevision < currentRevision &&
      firstReplay &&
      (firstReplay.revision === afterRevision + 1 || firstReplay.event.type === "reset");

    if (canReplay) {
      for (const entry of replay) {
        subscriber(entry.event, entry.revision);
      }
    } else {
      subscriber(
        withRevision({ type: "reset", state: getState(sessionId) }, currentRevision),
        currentRevision,
      );
    }
  }

  return () => {
    webSession.subscribers.delete(subscriber);
    if (
      webSession.ephemeral &&
      webSession.subscribers.size === 0 &&
      !webSession.session.isStreaming
    ) {
      disposeWebSession(webSession);
    }
  };
}
