import { get, set } from "idb-keyval";
import { normalizeSessionState } from "@/client/lib/session-state";
import type { BootstrapPayload, SessionState } from "@/shared/types";

const BOOTSTRAP_KEY = "pi-face:bootstrap";

export function cloneForCache<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function readCachedBootstrap(): Promise<BootstrapPayload | undefined> {
  return (await get<BootstrapPayload>(BOOTSTRAP_KEY)) ?? undefined;
}

export async function writeCachedBootstrap(payload: BootstrapPayload): Promise<void> {
  await set(BOOTSTRAP_KEY, cloneForCache(payload));
}

export async function readCachedSession(sessionId: string): Promise<SessionState | undefined> {
  return normalizeSessionState(await get<SessionState>(`pi-face:session:${sessionId}`));
}

export async function writeCachedSession(session: SessionState): Promise<void> {
  await set(`pi-face:session:${session.sessionId}`, cloneForCache(normalizeSessionState(session)));
}
