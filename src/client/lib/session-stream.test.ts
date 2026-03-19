import { describe, expect, it } from "vite-plus/test";
import { sessionEventsPath } from "@/client/lib/session-stream";

describe("session-stream", () => {
  it("includes workspace and session path for resumable event streams", () => {
    expect(
      sessionEventsPath({
        id: "session/123",
        workspaceId: "batty",
        path: "/root/github/batty/.pi/sessions/demo session.jsonl",
      }),
    ).toBe(
      "/api/sessions/session%2F123/events?workspaceId=batty&sessionPath=%2Froot%2Fgithub%2Fbatty%2F.pi%2Fsessions%2Fdemo+session.jsonl",
    );
  });

  it("still includes the workspace when no session path exists", () => {
    expect(
      sessionEventsPath({
        id: "session-123",
        workspaceId: "batty",
        path: undefined,
      }),
    ).toBe("/api/sessions/session-123/events?workspaceId=batty");
  });
});
