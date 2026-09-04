import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";
import type { PreparedInteractiveTurnSubmission } from "./active-interactive-turn-journal";
import { prepareInteractiveTurnRecovery } from "./interactive-turn-recovery";

const initial: PreparedInteractiveTurnSubmission = {
  text: "Do the work",
  images: [],
  clientMessageId: "client-1",
};
const queued: PreparedInteractiveTurnSubmission = {
  text: "Also check tests",
  images: [],
  clientMessageId: "client-2",
  streamingBehavior: "followUp",
};

function entry(
  id: string,
  message: Record<string, unknown>,
  parentId: string | null,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message,
  } as unknown as SessionEntry;
}

function session(entries: SessionEntry[]): {
  value: AgentSession;
  appendMessage: ReturnType<typeof vi.fn>;
  branch: ReturnType<typeof vi.fn>;
  agentMessages: Array<Record<string, unknown>>;
} {
  const appendMessage = vi.fn();
  const branch = vi.fn();
  const agentMessages = entries.flatMap((candidate) =>
    candidate.type === "message" ? [candidate.message as unknown as Record<string, unknown>] : [],
  );
  return {
    value: {
      sessionManager: { getBranch: () => entries, appendMessage, branch, resetLeaf: vi.fn() },
      agent: { state: { messages: agentMessages } },
    } as unknown as AgentSession,
    appendMessage,
    branch,
    agentMessages,
  };
}

describe("prepareInteractiveTurnRecovery", () => {
  it("replays the journaled prompt when it was not persisted", () => {
    const target = session([]);
    expect(prepareInteractiveTurnRecovery(target.value, [initial])).toEqual({
      action: "prompt",
      pendingSubmissions: [initial],
    });
  });

  it("continues a persisted user message without duplicating it", () => {
    const target = session([
      entry(
        "user-1",
        {
          role: "user",
          content: [{ type: "text", text: initial.text }],
          clientMessageId: "client-1",
        },
        null,
      ),
    ]);
    expect(prepareInteractiveTurnRecovery(target.value, [initial])).toEqual({
      action: "resume",
      pendingSubmissions: [],
    });
  });

  it("does not restart a turn whose final assistant response was persisted", () => {
    const target = session([
      entry("user-1", { role: "user", content: [], clientMessageId: "client-1" }, null),
      entry(
        "assistant-1",
        { role: "assistant", content: [{ type: "text", text: "Done" }] },
        "user-1",
      ),
    ]);
    expect(prepareInteractiveTurnRecovery(target.value, [initial])).toEqual({
      action: "complete",
      pendingSubmissions: [],
    });
  });

  it("retries from before a persisted provider error", () => {
    const target = session([
      entry("user-1", { role: "user", content: [], clientMessageId: "client-1" }, null),
      entry(
        "assistant-1",
        { role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded" },
        "user-1",
      ),
    ]);

    expect(prepareInteractiveTurnRecovery(target.value, [initial]).action).toBe("resume");
    expect(target.branch).toHaveBeenCalledWith("user-1");
    expect(target.agentMessages).toHaveLength(2);
    expect(target.value.agent.state.messages).toHaveLength(1);
  });

  it("starts an undelivered queued prompt after a completed response", () => {
    const target = session([
      entry("user-1", { role: "user", content: [], clientMessageId: "client-1" }, null),
      entry(
        "assistant-1",
        { role: "assistant", content: [{ type: "text", text: "Done" }] },
        "user-1",
      ),
    ]);
    expect(prepareInteractiveTurnRecovery(target.value, [initial, queued])).toEqual({
      action: "prompt",
      pendingSubmissions: [queued],
    });
  });

  it("records uncertain errors for interrupted tools rather than running them twice", () => {
    const target = session([
      entry("user-1", { role: "user", content: [], clientMessageId: "client-1" }, null),
      entry(
        "assistant-1",
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
            { type: "toolCall", id: "call-2", name: "write", arguments: {} },
          ],
        },
        "user-1",
      ),
      entry(
        "result-1",
        { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [], isError: false },
        "assistant-1",
      ),
    ]);

    expect(prepareInteractiveTurnRecovery(target.value, [initial]).action).toBe("resume");
    expect(target.appendMessage).toHaveBeenCalledTimes(1);
    expect(target.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "toolResult", toolCallId: "call-2", isError: true }),
    );
    expect(target.agentMessages.at(-1)).toEqual(
      expect.objectContaining({ role: "toolResult", toolCallId: "call-2", isError: true }),
    );
  });
});
