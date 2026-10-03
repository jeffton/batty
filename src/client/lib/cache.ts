import { get, set } from "idb-keyval";
import { RECENT_SESSION_MESSAGE_WINDOW } from "@/shared/session-history";
import type { BootstrapPayload, SessionState } from "@/shared/types";

const CACHE_VERSION = "v3";
const BOOTSTRAP_KEY = `batty:${CACHE_VERSION}:bootstrap`;

function sessionCacheKey(sessionId: string): string {
  return `batty:${CACHE_VERSION}:session:${sessionId}`;
}

export function cloneForCache<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function trimSessionForCache(session: SessionState): SessionState {
  const messageCount = session.messages.length;
  const messages = session.messages.slice(-RECENT_SESSION_MESSAGE_WINDOW);
  const totalMessageCount = Math.max(session.totalMessageCount, messageCount);

  return {
    ...session,
    messages,
    totalMessageCount,
    hasMoreMessages: session.hasMoreMessages || totalMessageCount > messages.length,
  };
}

export async function readCachedBootstrap(): Promise<BootstrapPayload | undefined> {
  return get<BootstrapPayload>(BOOTSTRAP_KEY);
}

export async function writeCachedBootstrap(payload: BootstrapPayload): Promise<void> {
  await set(BOOTSTRAP_KEY, cloneForCache(payload));
}

export async function readCachedSession(sessionId: string): Promise<SessionState | undefined> {
  return get<SessionState>(sessionCacheKey(sessionId));
}

export async function writeCachedSession(session: SessionState): Promise<void> {
  await set(sessionCacheKey(session.sessionId), cloneForCache(trimSessionForCache(session)));
}
