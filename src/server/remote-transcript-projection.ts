import type { NodeMessage, NodeSessionEvent, NodeWorkerSummary } from "../shared/node-api";
import type { SessionState, UiMessage } from "../shared/types";
import { nodeSessionEvent } from "./remote-presentation";

export const remoteSessionId = (node: string, session: string) => `remote:${node}:${session}`;
export function parseRemoteSession(id: string) {
  const match = /^remote:([a-zA-Z0-9_-]+):(\d+)$/.exec(id);
  return match ? { node: match[1]!, session: match[2]! } : undefined;
}

export type RemoteMirror = {
  node: string;
  session: string;
  summary: NodeWorkerSummary;
  state?: SessionState;
  after?: string;
  messages: UiMessage[];
  error?: string;
  syncedTerminal?: boolean;
  projectionReady?: true;
  projectionError?: string;
};

export function projectRemoteSender(
  message: Extract<NodeMessage, { role: "custom" }>,
  node: string,
  name: string,
): Extract<NodeMessage, { role: "custom" }> {
  const sender = message.steeringSender;
  // A mirror may identify sessions on the connected peer, not on another installation.
  if (message.transferOrigin)
    return {
      ...message,
      steeringSender: { kind: "peer", name: message.transferOrigin.label },
    };
  if (sender?.kind === "main") return { ...message, steeringSender: { kind: "main", name } };
  if (sender?.kind !== "agent") return message;
  return {
    ...message,
    steeringSender: /^\d+$/.test(sender.sessionId)
      ? {
          kind: "agent",
          sessionId: remoteSessionId(node, sender.sessionId),
          name: `Agent ${sender.sessionId} · ${name}`,
        }
      : { kind: "peer", name: sender.name ?? sender.sessionId },
  };
}

function refreshMessage(cached: UiMessage, message: NodeMessage, node: string, name: string) {
  if (cached.role === "custom" && message.role === "custom") {
    const { steeringSender, transferKind, transferOrigin } = projectRemoteSender(
      message,
      node,
      name,
    );
    return { ...cached, steeringSender, transferKind, transferOrigin };
  }
  if (cached.role === "assistant" && message.role === "assistant")
    return { ...cached, directDelivery: message.directDelivery };
  return cached;
}

export async function refreshTranscriptProjection(
  mirror: RemoteMirror,
  name: string,
  events: ReadableStream<NodeSessionEvent>,
) {
  const end = Number(mirror.after);
  const archived = new Map(mirror.messages.map((message) => [message.id, message]));
  const refreshed = new Map<string, UiMessage>();
  const reader = events.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return false;
      const event = nodeSessionEvent(next.value, true);
      if (event?.type === "error") throw new Error(event.message);
      if (event?.type !== "reset") continue;
      const { state } = event;
      if (!event.senderProjection) return false;
      for (const message of state.messages) {
        const cached = archived.get(message.id);
        if (cached) refreshed.set(message.id, refreshMessage(cached, message, mirror.node, name));
      }
      if (Number(state.historyCursor) < end && state.hasMoreRecentMessages) continue;
      mirror.messages = mirror.messages.map((message) => refreshed.get(message.id) ?? message);
      mirror.projectionReady = true;
      return true;
    }
  } finally {
    await reader.cancel();
  }
}
