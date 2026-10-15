import { expect, test } from "vite-plus/test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { projectEntry } from "./memory-projection";

test("projection keeps tools and exact text but excludes reasoning", () => {
  const entry = {
    id: 9,
    conversationId: 1,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        timestamp: 1000,
        content: [
          { type: "thinking", thinking: "secret", thinkingSignature: "encrypted" },
          { type: "text", text: "Finding" },
          { type: "toolCall", name: "read", arguments: { path: "file" }, id: "call" },
        ],
      },
    ],
  } as unknown as EntryRecord;
  expect(projectEntry(entry)).toMatchObject([
    { kind: "talk", text: "Finding", source: 9, ordinal: 0 },
    { kind: "tool", text: 'read {"path":"file"}', source: 9, ordinal: 1 },
  ]);
  expect(JSON.stringify(projectEntry(entry))).not.toContain("secret");
});
