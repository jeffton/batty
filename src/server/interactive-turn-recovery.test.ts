import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";
import { prepareInteractiveTurnRecovery, resumeInteractiveTurn } from "./interactive-turn-recovery";

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

const user = entry(
  "user",
  { role: "user", content: [{ type: "text", text: "Do the work" }] },
  null,
);
const completed = entry(
  "done",
  { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
  "user",
);
const tools = entry(
  "tools",
  {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
      { type: "toolCall", id: "call-2", name: "write", arguments: {} },
    ],
    stopReason: "toolUse",
  },
  "user",
);
const result = (id: string) =>
  entry(
    `result-${id}`,
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "bash",
      content: [],
      isError: false,
    },
    "tools",
  );

function session(entries: SessionEntry[]) {
  return {
    sessionManager: { appendMessage: vi.fn(), branch: vi.fn(), resetLeaf: vi.fn() },
    agent: {
      state: { messages: entries.flatMap((e) => (e.type === "message" ? [e.message] : [])) },
    },
    resumeInterruptedTurn: vi.fn().mockResolvedValue(undefined),
  };
}

describe("interactive turn recovery", () => {
  it("does not replay an unpersisted prompt", () => {
    expect(prepareInteractiveTurnRecovery([])).toEqual({ action: "complete" });
  });

  it("continues a persisted user message without duplicating it", async () => {
    const plan = prepareInteractiveTurnRecovery([user]);
    expect(plan).toEqual({ action: "resume", toolResults: [] });
    const target = session([user]);
    if (plan.action !== "resume") throw new Error("Expected resume");
    await resumeInteractiveTurn(target as unknown as AgentSession, plan);
    expect(target.sessionManager.appendMessage).not.toHaveBeenCalled();
    expect(target.resumeInterruptedTurn).toHaveBeenCalledOnce();
  });

  it("does not restart completed turns or replay their older tool calls", () => {
    expect(prepareInteractiveTurnRecovery([user, completed])).toEqual({ action: "complete" });
    expect(
      prepareInteractiveTurnRecovery([user, tools, result("call-1"), result("call-2"), completed]),
    ).toEqual({ action: "complete" });
  });

  it.each(["error", "length"])(
    "rewinds an interrupted %s response only when executing recovery",
    async (stopReason) => {
      const entries = [
        user,
        entry("error", { role: "assistant", content: [], stopReason }, "user"),
      ];
      const target = session(entries);
      const plan = prepareInteractiveTurnRecovery(entries);
      expect(plan).toEqual({ action: "resume", toolResults: [], rewindTo: "user" });
      expect(target.sessionManager.branch).not.toHaveBeenCalled();
      if (plan.action !== "resume") throw new Error("Expected resume");
      await resumeInteractiveTurn(target as unknown as AgentSession, plan);
      expect(target.sessionManager.branch).toHaveBeenCalledWith("user");
      expect(target.agent.state.messages).toHaveLength(1);
    },
  );

  it("records unknown tool outcomes before continuing, without reexecuting tools", async () => {
    const entries = [user, tools, result("call-1")];
    const target = session(entries);
    const plan = prepareInteractiveTurnRecovery(entries);
    expect(target.sessionManager.appendMessage).not.toHaveBeenCalled();
    expect(entries).toHaveLength(3);
    if (plan.action !== "resume") throw new Error("Expected resume");
    expect(plan.toolResults).toEqual([
      expect.objectContaining({ toolCallId: "call-2", isError: true }),
    ]);
    target.resumeInterruptedTurn.mockImplementation(async () => {
      expect(target.sessionManager.appendMessage).toHaveBeenCalledExactlyOnceWith(
        plan.toolResults[0],
      );
      expect(target.agent.state.messages.at(-1)).toEqual(plan.toolResults[0]);
    });
    await resumeInteractiveTurn(target as unknown as AgentSession, plan);
  });

  it("continues after persisted tool results without adding synthetic results", () => {
    expect(
      prepareInteractiveTurnRecovery([user, tools, result("call-1"), result("call-2")]),
    ).toEqual({ action: "resume", toolResults: [] });
  });

  it("continues a queued prompt that already entered the transcript", () => {
    expect(
      prepareInteractiveTurnRecovery([
        user,
        completed,
        entry("next", { role: "user", content: [] }, "done"),
      ]),
    ).toEqual({ action: "resume", toolResults: [] });
  });
});
