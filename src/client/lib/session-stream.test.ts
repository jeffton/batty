import { describe, expect, it } from "vite-plus/test";
import { sessionEventsPath } from "./session-stream";
describe("session stream routing", () => {
  it("preserves reconnect routing without replay cursors", () => {
    const path = sessionEventsPath({ id: "web-a", workspaceId: "batty", path: "/tmp/a.jsonl" });
    expect(path).toContain("workspaceId=batty");
    expect(path).toContain("sessionPath=%2Ftmp%2Fa.jsonl");
    expect(path).not.toContain("afterRevision");
    expect(path).not.toContain("afterStreamId");
  });
});
