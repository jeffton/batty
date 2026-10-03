import { describe, expect, it } from "vite-plus/test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionRead } from "./session-store";
import {
  readQueuedSubagentOperations,
  SUBAGENT_OPERATION_CUSTOM_TYPE,
  SUBAGENT_QUEUE_CUSTOM_TYPE,
} from "./subagent-recovery";

const entry = (customType: string, data: unknown): SessionEntry => ({
  type: "custom",
  id: crypto.randomUUID(),
  parentId: null,
  timestamp: new Date().toISOString(),
  customType,
  data,
});
const snapshot = (entries: SessionEntry[]): SessionRead => ({
  metadata: {
    type: "session",
    version: 3,
    id: "child",
    cwd: "/workspace",
    timestamp: "",
    parentSession: "source",
    path: "/child.sqlite",
    modifiedAt: 0,
  },
  entries,
});

describe("subagent queue recovery ownership", () => {
  it("does not recover pending requests inherited from a full-context fork", () => {
    expect(
      readQueuedSubagentOperations(
        snapshot([
          entry("batty-subagent-session", { sessionId: "source" }),
          entry(SUBAGENT_QUEUE_CUSTOM_TYPE, { operationId: "source-queued", options: {} }),
          entry("batty-subagent-session", { sessionId: "child" }),
        ]),
      ),
    ).toEqual([]);
  });
  it("preserves own FIFO requests across continuation markers and ignores activated requests", () => {
    const entries = [
      entry("batty-subagent-session", { sessionId: "child" }),
      entry(SUBAGENT_QUEUE_CUSTOM_TYPE, { operationId: "first", options: {} }),
      entry("batty-subagent-session", { sessionId: "child" }),
      entry(SUBAGENT_QUEUE_CUSTOM_TYPE, { operationId: "second", options: {} }),
    ];
    expect(readQueuedSubagentOperations(snapshot(entries)).map((item) => item.operationId)).toEqual(
      ["first", "second"],
    );
    entries.push(entry(SUBAGENT_OPERATION_CUSTOM_TYPE, { operationId: "first" }));
    expect(readQueuedSubagentOperations(snapshot(entries)).map((item) => item.operationId)).toEqual(
      ["second"],
    );
  });
});
