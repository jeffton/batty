import { get, set } from "idb-keyval";
import { RECENT_SESSION_MESSAGE_WINDOW } from "@/shared/session-history";
import type { BootstrapPayload, SessionSnapshot } from "@/shared/types";

const CACHE_VERSION = "v4-native";
const BOOTSTRAP_KEY = `batty:${CACHE_VERSION}:bootstrap`;

function sessionCacheKey(sessionId: string): string {
  return `batty:${CACHE_VERSION}:session:${sessionId}`;
}

export function cloneForCache<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function trimSessionForCache(session: SessionSnapshot): SessionSnapshot {
  const messageCount = session.messages.length;
  const keepCount = Math.min(RECENT_SESSION_MESSAGE_WINDOW, messageCount);
  const messages = session.messages.slice(messageCount - keepCount);
  const totalMessageCount = Math.max(session.metadata.totalMessageCount, messageCount);

  return {
    ...session,
    messages,
    metadata: {
      ...session.metadata,
      totalMessageCount,
      hasMoreMessages: session.metadata.hasMoreMessages || totalMessageCount > messages.length,
    },
  };
}

export async function readCachedBootstrap(): Promise<BootstrapPayload | undefined> {
  return (await get<BootstrapPayload>(BOOTSTRAP_KEY)) ?? undefined;
}

export async function writeCachedBootstrap(payload: BootstrapPayload): Promise<void> {
  await set(BOOTSTRAP_KEY, cloneForCache(payload));
}

export async function readCachedSession(sessionId: string): Promise<SessionSnapshot | undefined> {
  return await get<SessionSnapshot>(sessionCacheKey(sessionId));
}

export async function writeCachedSession(session: SessionSnapshot): Promise<void> {
  await set(
    sessionCacheKey(session.metadata.sessionId),
    cloneForCache(trimSessionForCache(session)),
  );
}
