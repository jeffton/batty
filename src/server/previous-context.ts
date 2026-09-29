import type { Message } from "@earendil-works/pi-ai";
import type { PreviousContextMode } from "@/shared/types";
import { chatOnlyMessagesFromBranch } from "./chat-only-context";
import { SessionStore as SessionManager } from "./session-store";

export async function createSessionManagerWithPreviousContext(options: {
  cwd: string;
  targetRoot: string;
  parentSessionId?: string;
  sessionId?: string;
  sourceSessionPath?: string;
  leafId?: string | null;
  mode: PreviousContextMode;
}): Promise<{ manager: SessionManager; chatOnlyMessages?: Message[] }> {
  if (!options.mode) {
    return {
      manager: await SessionManager.create(
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

  const source = await SessionManager.open(options.sourceSessionPath);
  if (options.mode === true) {
    // Native branch forks retain Pi's cache lineage and preserve prompt-cache reuse.
    return {
      manager: await source.fork(options.targetRoot, options.leafId ?? null, options.sessionId),
    };
  }

  const branch = options.leafId ? source.getBranch(options.leafId) : [];
  return {
    manager: await SessionManager.create(
      options.cwd,
      options.targetRoot,
      options.parentSessionId,
      options.sessionId,
    ),
    chatOnlyMessages: chatOnlyMessagesFromBranch(branch),
  };
}
