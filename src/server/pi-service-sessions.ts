import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  ServerEvent,
  SessionState,
  SessionStateMetadata,
  WorkspaceInfo,
} from "@/shared/types";
import { normalizeBlocks } from "./pi-state";
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

export function publish(webSession: WebSession, event: ServerEvent): void {
  for (const subscriber of webSession.subscribers) {
    subscriber(event);
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
    case "message_update":
      if (event.message.role === "assistant") {
        webSession.activeAssistant = event.message;
        deps.publish(webSession, {
          type: "assistant",
          assistant: deps.getState(webSession.id).activeAssistant,
        });
      }
      break;
    case "message_end":
      if (event.message.role === "assistant") {
        const blocks = normalizeBlocks(event.message.content);
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
      deps.publish(webSession, { type: "tools", tools: [...webSession.activeTools.values()] });
      break;
    case "tool_execution_update": {
      const current = webSession.activeTools.get(event.toolCallId);
      if (current) {
        const blocks = normalizeBlocks(event.partialResult.content ?? []);
        current.blocks = current.toolName === "bash" ? sanitizeTerminalBlocks(blocks) : blocks;
        current.details = normalizeToolDetails(event.partialResult.details);
        webSession.activeTools.set(event.toolCallId, current);
        deps.publish(webSession, { type: "tools", tools: [...webSession.activeTools.values()] });
      }
      break;
    }
    case "tool_execution_end": {
      const current = webSession.activeTools.get(event.toolCallId);
      if (current) {
        const blocks = normalizeBlocks(event.result.content ?? []);
        current.blocks = current.toolName === "bash" ? sanitizeTerminalBlocks(blocks) : blocks;
        current.status = event.isError ? "error" : "success";
        current.isError = event.isError;
        current.details = normalizeToolDetails(event.result.details);
        webSession.activeTools.set(event.toolCallId, current);
        deps.publish(webSession, { type: "tools", tools: [...webSession.activeTools.values()] });
      }
      break;
    }
    case "agent_start":
      webSession.activeTools.clear();
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
      if (event.type === "agent_end") {
        webSession.activeAssistant = undefined;
      }
      const state = deps.getState(webSession.id);
      const publishedState =
        event.type === "agent_end"
          ? {
              ...state,
              isStreaming: false,
              pendingMessageCount: 0,
              activeAssistant: undefined,
            }
          : state;
      deps.publish(webSession, { type: "reset", state: publishedState });

      if (event.type === "auto_retry_end") {
        webSession.autoRetryActive = false;
        if (!state.isStreaming) {
          webSession.suppressNextAgentEndCompletion = true;
          await runCompletionHook(deps, webSession, state);
        }
        break;
      }

      if (event.type === "agent_end") {
        if (webSession.suppressNextAgentEndCompletion) {
          webSession.suppressNextAgentEndCompletion = false;
          break;
        }
        if (!webSession.autoRetryActive) {
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
): () => void {
  const webSession = requireSession(sessionId);
  webSession.subscribers.add(subscriber);
  subscriber({ type: "reset", state: getState(sessionId) });
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
