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
      getEntries: () => entries,
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

  it("bounds pages by projected bytes as well as message count", () => {
    const messages = [
      userMessage(1, "a".repeat(400 * 1024)),
      userMessage(2, "b".repeat(400 * 1024)),
      userMessage(3, "latest"),
    ];

    const page = getSessionMessagePage(makeSession(messages));

    expect(page.messages).toEqual(messages.slice(1));
    expect(page.hasMoreMessages).toBe(true);
    expect(page.messageIndexOffset).toBe(1);
  });

  it("does not count inline image data against the projected UI byte budget", () => {
    const messages = [
      {
        role: "toolResult",
        toolCallId: "image-1",
        toolName: "read",
        timestamp: 1,
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: Buffer.alloc(2 * 1024 * 1024).toString("base64"),
          },
        ],
        isError: false,
      },
      userMessage(2, "latest"),
    ];

    const page = getSessionMessagePage(makeSession(messages));

    expect(page.messages).toEqual(messages);
    expect(page.hasMoreMessages).toBe(false);
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
