import { describe, expect, it } from "vite-plus/test";
import { applyServerEvent } from "./session-events";
import { makeSnapshot } from "./session-test-fixture";
import { presentSession } from "./session-presentation";
describe("native session events", () => {
  it("hydrates a fresh base and drops old live fields", () => {
    const old = makeSnapshot();
    old.documents = { ...old.documents, "pi.live": { run: { taskId: 1 as never, inputs: [] } } };
    const base = makeSnapshot();
    const result = applyServerEvent(old, { type: "session", snapshot: base })!;
    expect(result.documents).toBe(base.documents);
    expect(presentSession(result)?.isStreaming).toBe(false);
  });
  it("uses immutable native deltas, including tool output truncation", () => {
    const old = makeSnapshot();
    const next = applyServerEvent(old, {
      type: "session-update",
      metadata: old.metadata,
      queuedClientMessageIds: {},
      historyVersion: 0,
      documents: [
        [
          "s",
          ["pi.live", "tools"],
          [
            {
              callId: "call",
              name: "bash",
              status: "running",
              output: "\u001b[31mhello\u001b[0m",
              droppedLines: 8,
            },
          ],
        ],
      ],
    })!;
    expect(old.documents["pi.live"].tools).toBeUndefined();
    expect(presentSession(next)?.activeTools[0]).toMatchObject({
      blocks: [{ type: "text", text: "hello" }],
      details: { droppedLines: 8 },
    });
  });
  it("ignores older history but accepts live changes in connection order", () => {
    const old = makeSnapshot("a", { historyVersion: 10 });
    const next = applyServerEvent(old, {
      type: "session-update",
      metadata: old.metadata,
      documents: [["s", ["pi.live", "run"], { taskId: 1, inputs: [] }]],
      messages: [],
      queuedClientMessageIds: {},
      historyVersion: 9,
    })!;
    expect(next.historyVersion).toBe(10);
    expect(presentSession(next)?.isStreaming).toBe(true);
  });
});
