import type { Message } from "@earendil-works/pi-ai";
import type { PreviousContextMode } from "@/shared/types";
import { chatOnlyMessagesFromBranch } from "./chat-only-context";
import { SessionStore } from "./session-store";
import { boundedSessionEntries } from "./session-metadata";

export async function createSessionManagerWithPreviousContext(options: {
  cwd: string;
  targetRoot: string;
  parentSessionId?: string;
  sessionId?: string;
  sourceSessionPath?: string;
  leafId?: string | null;
  mode: PreviousContextMode;
}): Promise<{ manager: SessionStore; chatOnlyMessages?: Message[] }> {
  if (!options.mode) {
    return {
      manager: await SessionStore.create(
        options.cwd,
        options.targetRoot,
        options.parentSessionId,
        options.sessionId,
      ),
    };
  }
  if (!options.sourceSessionPath) {
    throw new Error("Cannot include previous context without a persisted parent session");
  }

  if (options.mode === true) {
    return SessionStore.withSource(options.sourceSessionPath, async (source) => ({
      manager: await source.fork(options.targetRoot, options.leafId ?? null, options.sessionId),
    }));
  }

  const { entries } = await SessionStore.read(options.sourceSessionPath, { readOnly: true });
  const branch = options.leafId ? boundedSessionEntries(entries, null, options.leafId) : [];
  return {
    manager: await SessionStore.create(
      options.cwd,
      options.targetRoot,
      options.parentSessionId,
      options.sessionId,
    ),
    chatOnlyMessages: chatOnlyMessagesFromBranch(branch),
  };
}
