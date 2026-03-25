import { get, set } from "idb-keyval";
import { normalizeSessionState } from "@/client/lib/session-state";
import { RECENT_SESSION_MESSAGE_WINDOW } from "@/shared/session-history";
import type { BootstrapPayload, SessionState } from "@/shared/types";

const BOOTSTRAP_KEY = "batty:bootstrap";

export function cloneForCache<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function trimSessionForCache(session: SessionState): SessionState {
  const messageCount = session.messages.length;
  const keepCount = Math.min(RECENT_SESSION_MESSAGE_WINDOW, messageCount);
  const messages = session.messages.slice(messageCount - keepCount);
  const totalMessageCount = Math.max(session.totalMessageCount, messageCount);

  return {
    ...session,
    messages,
    totalMessageCount,
    hasMoreMessages: session.hasMoreMessages || totalMessageCount > messages.length,
  };
}

export async function readCachedBootstrap(): Promise<BootstrapPayload | undefined> {
  return (await get<BootstrapPayload>(BOOTSTRAP_KEY)) ?? undefined;
}

export async function writeCachedBootstrap(payload: BootstrapPayload): Promise<void> {
  await set(BOOTSTRAP_KEY, cloneForCache(payload));
}

export async function readCachedSession(sessionId: string): Promise<SessionState | undefined> {
  return normalizeSessionState(await get<SessionState>(`batty:session:${sessionId}`));
}

export async function writeCachedSession(session: SessionState): Promise<void> {
  const normalized = normalizeSessionState(session);
  if (!normalized) {
    return;
  }

  await set(`batty:session:${session.sessionId}`, cloneForCache(trimSessionForCache(normalized)));
}
