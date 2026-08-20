import { afterEach, describe, expect, it } from "vite-plus/test";
import { sessionEventsPath } from "@/client/lib/session-stream";

afterEach(() => {
  delete window.__BATTY_BASE_URL__;
});

describe("session-stream", () => {
  it("includes workspace and session path for resumable event streams", () => {
    expect(
      sessionEventsPath({
        id: "session/123",
        workspaceId: "batty",
        path: "/root/github/.batty/sessions/batty/demo session.jsonl",
      }),
    ).toBe(
      "/api/sessions/session%2F123/events?workspaceId=batty&sessionPath=%2Froot%2Fgithub%2F.batty%2Fsessions%2Fbatty%2Fdemo+session.jsonl",
    );
  });

  it("starts after the revision returned by session open", () => {
    expect(
      sessionEventsPath({
        id: "session-123",
        workspaceId: "batty",
        path: undefined,
        revision: 42,
      }),
    ).toBe("/api/sessions/session-123/events?workspaceId=batty&afterRevision=42");
  });

  it("can request full reset details for popover transcripts", () => {
    expect(
      sessionEventsPath(
        {
          id: "session-123",
          workspaceId: "batty",
          path: undefined,
          revision: 42,
        },
        "full",
      ),
    ).toBe(
      "/api/sessions/session-123/events?workspaceId=batty&afterRevision=42&messagesDetailLevel=full",
    );
  });

  it("prefixes the event stream with the configured base url", () => {
    window.__BATTY_BASE_URL__ = "/batty";

    expect(
      sessionEventsPath({
        id: "session-123",
        workspaceId: "batty",
        path: undefined,
      }),
    ).toBe("/batty/api/sessions/session-123/events?workspaceId=batty");
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
