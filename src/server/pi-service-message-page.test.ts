import { describe, expect, it } from "vite-plus/test";
import { RECENT_SESSION_MESSAGE_WINDOW } from "@/shared/session-history";
import { CRON_RUN_SESSION_CUSTOM_TYPE } from "./cron-session";
import { getSessionMessagePage } from "./pi-service-message-page";

function makeSession(messages: unknown[]): never {
  return makeSessionFromEntries(messages.map((message) => ({ type: "message", message })));
}

function makeSessionFromEntries(entries: unknown[]): never {
  return {
    sessionManager: {
      getBranch: () => entries,
    },
  } as never;
}

function userMessage(timestamp: number, text: string): unknown {
  return {
    role: "user",
    timestamp,
    content: [{ type: "text", text }],
  };
}

describe("getSessionMessagePage", () => {
  it("returns the most recent default message window", () => {
    const messages = Array.from({ length: RECENT_SESSION_MESSAGE_WINDOW + 2 }, (_, index) =>
      userMessage(index + 1, `message-${index + 1}`),
    );

    const page = getSessionMessagePage(makeSession(messages));

    expect(page.messages).toEqual(messages.slice(2));
    expect(page.totalMessageCount).toBe(messages.length);
    expect(page.hasMoreMessages).toBe(true);
    expect(page.messageIndexOffset).toBe(2);
  });

  it("filters copied parent context out of cron run sessions", () => {
    const page = getSessionMessagePage(
      makeSessionFromEntries([
        { type: "message", message: userMessage(1, "copied parent") },
        {
          type: "custom",
          customType: CRON_RUN_SESSION_CUSTOM_TYPE,
          data: { runId: "run-1" },
        },
        {
          type: "custom_message",
          customType: "batty-runtime-notice:cron",
          content: "Cron run triggered.",
          timestamp: "2026-05-16T10:30:00.904Z",
        },
        { type: "message", message: userMessage(2, "run result") },
      ]),
    );

    expect(page.messages).toEqual([
      {
        role: "custom",
        customType: "batty-runtime-notice:cron",
        content: "Cron run triggered.",
        timestamp: Date.parse("2026-05-16T10:30:00.904Z"),
        data: undefined,
      },
      userMessage(2, "run result"),
    ]);
    expect(page.totalMessageCount).toBe(2);
    expect(page.hasMoreMessages).toBe(false);
    expect(page.messageIndexOffset).toBe(0);
  });

  it("uses the requested limit when loading older messages", () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      userMessage(index + 1, `message-${index + 1}`),
    );

    const page = getSessionMessagePage(makeSession(messages), {
      beforeMessageId: "user-8-7",
      limit: 3,
    });

    expect(page.messages).toEqual(messages.slice(4, 7));
    expect(page.hasMoreMessages).toBe(true);
    expect(page.messageIndexOffset).toBe(4);
  });
});
