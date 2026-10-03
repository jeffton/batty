import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/chord";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { SessionSnapshot, WorkspaceInfo } from "@/shared/types";
import type { AgentSessionController, SessionControllerEvent } from "./agent-session-controller";
import type { UiImageResolver } from "./pi-state";
import type { SessionSubscriber, WebSession } from "./pi-service-types";

const disposingSessions = new WeakMap<WebSession, Promise<void>>();

export function isWebSessionDisposing(webSession: WebSession): boolean {
  return disposingSessions.has(webSession);
}

export function disposeWebSession(
  sessions: Map<string, WebSession>,
  unregisterLiveSession: (sessionId: string) => void,
  webSession: WebSession,
  closeBrowser?: () => Promise<void>,
): Promise<void> {
  const existing = disposingSessions.get(webSession);
  if (existing) return existing;
  const disposal = Promise.all([
    webSession.session.waitForIdle().then(() => webSession.session.dispose()),
    closeBrowser?.(),
  ]).then(() => {
    if (sessions.get(webSession.id) === webSession) {
      sessions.delete(webSession.id);
      unregisterLiveSession(webSession.id);
    }
  });
  disposingSessions.set(webSession, disposal);
  // Settlement delivery cannot await disposal, which drains that same delivery.
  void disposal.catch((error) => console.error("Failed to close Pi harness", error));
  return disposal;
}

export function attachSession(
  sessions: Map<string, WebSession>,
  registerLiveSession: (workspace: WorkspaceInfo, session: AgentSessionController) => void,
  handleEvent: (session: WebSession, event: SessionControllerEvent) => Promise<void>,
  workspace: WorkspaceInfo,
  session: AgentSessionController,
  modelFallbackMessage?: string,
  ephemeral = false,
  resolveUiImage?: UiImageResolver,
): WebSession {
  const webSession: WebSession = {
    id: session.sessionId,
    workspace,
    session,
    subscribers: new Set(),
    openedAt: Date.now(),
    modelFallbackMessage,
    ephemeral,
    resolveUiImage,
  };
  session.subscribe((event) => handleEvent(webSession, event));
  sessions.set(webSession.id, webSession);
  registerLiveSession(workspace, session);
  return webSession;
}

/** Metadata/resource changes need no reconstructed live state or replay log. */
export function publish(webSession: WebSession): void {
  for (const refresh of webSession.subscribers) refresh();
}

export function requireSession(sessions: Map<string, WebSession>, sessionId: string): WebSession {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}

/** Native view operations projected to the native built-in documents only. */
export function documentOperations(
  ops: readonly Op[],
  documents: SessionSnapshot["documents"],
): Op[] {
  return ops.flatMap((op): Op[] => {
    if (op[0] === "r") return [["r", documents as unknown as JsonValue]];
    const path = op[1];
    if (path[0] !== "docs") return [];
    if (path.length === 1) return [["r", documents as unknown as JsonValue]];
    if (op[0] === "d" && path.length === 2) {
      const kind = path[1] as keyof typeof documents;
      return [["s", [kind], documents[kind] as unknown as JsonValue]];
    }
    return [[op[0], path.slice(1), ...op.slice(2)] as unknown as Op];
  });
}

/** Each connection attaches atomically and begins with a fresh native base. */
export async function subscribeToSession(
  requireSession: (sessionId: string) => WebSession,
  getSnapshot: (
    sessionId: string,
    view: ConversationView,
    previous?: SessionSnapshot,
  ) => SessionSnapshot,
  dispose: (session: WebSession) => void,
  sessionId: string,
  subscriber: SessionSubscriber,
): Promise<() => void> {
  const session = requireSession(sessionId);
  const watch = await session.session.sessionManager.conversation.watch(BACKGROUND_CONTEXT);
  let previous: SessionSnapshot;
  let stopped = false;
  const send = (view: ConversationView, ops: readonly Op[]) => {
    const snapshot = getSnapshot(sessionId, view, previous);
    const historyChanged = snapshot.historyVersion !== previous.historyVersion;
    subscriber({
      type: "session-update",
      documents: documentOperations(ops, snapshot.documents),
      metadata: snapshot.metadata,
      queuedClientMessageIds: snapshot.queuedClientMessageIds,
      ...(historyChanged ? { messages: snapshot.messages } : {}),
      historyVersion: snapshot.historyVersion,
    });
    previous = snapshot;
  };
  const refresh = () => send(watch.value, []);
  try {
    const snapshot = getSnapshot(sessionId, watch.value);
    subscriber({ type: "session", snapshot });
    previous = snapshot;
    session.subscribers.add(refresh);
    watch.start(async (view, ops) => send(view, ops));
  } catch (error) {
    await watch.stop();
    throw error;
  }
  const unsubscribe = () => {
    if (stopped) return;
    stopped = true;
    session.subscribers.delete(refresh);
    void watch.stop().catch((error) => console.error("Failed to stop session view", error));
    if (session.ephemeral && session.subscribers.size === 0 && !session.session.isStreaming) {
      dispose(session);
    }
  };
  void watch.closed.then((end) => {
    unsubscribe();
    if (end.reason === "listener_error") console.error("Session view listener failed", end.error);
  });
  return unsubscribe;
}
