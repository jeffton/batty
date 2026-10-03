import { describe, expect, it } from "vite-plus/test";
import { mergeSessionSnapshot } from "./session-state";
import { makeSnapshot } from "./session-test-fixture";
describe("snapshot history", () => {
  it("never restores live documents from loaded history", () => {
    const previous = makeSnapshot();
    const incoming = makeSnapshot();
    expect(mergeSessionSnapshot(incoming, previous).documents).toBe(incoming.documents);
  });
  it("rejects an older history window while accepting native documents", () => {
    const previous = makeSnapshot("a", {
      historyVersion: 10,
      messages: [{ id: "entry-10", role: "user", timestamp: 1, blocks: [] }],
    });
    const incoming = makeSnapshot("a", { historyVersion: 3 });
    const merged = mergeSessionSnapshot(incoming, previous);
    expect(merged.messages).toBe(previous.messages);
    expect(merged.documents).toBe(incoming.documents);
    expect(merged.historyVersion).toBe(10);
  });
});
