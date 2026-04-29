import { describe, expect, it } from "vite-plus/test";
import { RECENT_SESSION_MESSAGE_WINDOW } from "@/shared/session-history";
import { getSessionMessagePage } from "./pi-service-message-page";

function makeSession(messages: unknown[]): never {
  return {
    sessionManager: {
      getBranch: () => messages.map((message) => ({ type: "message", message })),
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
