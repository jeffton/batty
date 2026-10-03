import type { AgentSessionController } from "./agent-session-controller";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export function hasRestartResponse(entries: SessionEntry[], afterEntryId: string): boolean {
  const anchor = entries.findIndex((entry) => entry.id === afterEntryId);
  if (anchor < 0) throw new Error("Restart response anchor is missing");
  return entries
    .slice(anchor + 1)
    .some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        (entry.message.stopReason === "stop" || entry.message.stopReason === "length") &&
        !("battyDetachedReply" in entry.message && entry.message.battyDetachedReply),
    );
}

/** The shell invocation anchors its own response, even if a follow-up starts before IPC arrives. */
export async function waitForRestartResponse(
  session: AgentSessionController,
  afterEntryId: string,
): Promise<void> {
  const ready = () => hasRestartResponse(session.sessionManager.getBranch(), afterEntryId);
  if (ready()) return;
  if (!session.isStreaming) throw new Error("Deploying turn ended without a final response");
  await new Promise<void>((resolve, reject) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "message_end" && event.type !== "run_end") return;
      if (ready()) {
        unsubscribe();
        resolve();
      } else if (event.type === "run_end") {
        unsubscribe();
        reject(new Error("Deploying turn ended without a final response"));
      }
    });
  });
}
