import { describe, expect, it } from "vite-plus/test";
import {
  buildAgentCompletionNotificationContent,
  markdownToNotificationText,
  suppressAgentCompletionNotification,
} from "@/shared/agent-notification";
import type { SessionState } from "@/shared/types";

function createSession(markdown: string): SessionState {
  return {
    id: "session-1",
    sessionId: "session-1",
    workspaceId: "batty",
    cwd: "/root/github/batty",
    path: "/root/github/.batty/sessions/batty/session.jsonl",
    model: "openai-codex/gpt-5.4",
    modelLabel: "GPT-5.4 · OpenAI",
    thinkingLevel: "medium",
    availableThinkingLevels: ["medium"],
    isStreaming: false,
    pendingMessageCount: 0,
    updatedAt: 100,
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    totalMessageCount: 1,
    hasMoreMessages: false,
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        turnPhase: "final",
        timestamp: 100,
        blocks: [{ type: "text", text: markdown }],
      },
    ],
    activeTools: [],
  };
}

describe("markdownToNotificationText", () => {
  it("converts markdown to readable plain text", () => {
    expect(
      markdownToNotificationText(`# Done

- shipped **feature**
- docs: [README](https://example.com)

> looks good

\`pnpm test\``),
    ).toBe("Done\n\n• shipped feature\n• docs: README\n\nlooks good\n\npnpm test");
  });
});

describe("buildAgentCompletionNotificationContent", () => {
  it("uses plain text for the notification body", () => {
    expect(
      buildAgentCompletionNotificationContent(createSession("**Done** shipping the feature.")),
    ).toEqual(
      expect.objectContaining({
        title: "batty",
        body: "Done shipping the feature.",
        tag: "session-complete:session-1",
      }),
    );
  });
});

describe("suppressAgentCompletionNotification", () => {
  it("suppresses notifications for subagent sessions", () => {
    const session = createSession("Subagent done.");
    session.isSubagentSession = true;

    expect(suppressAgentCompletionNotification(session)).toBe(true);
  });

  it("suppresses notifications for cron sessions marked as hidden", () => {
    const session = createSession("Cron delivered to parent session.");
    session.isCronSession = true;

    expect(suppressAgentCompletionNotification(session)).toBe(true);
  });

  it("suppresses notifications for exact NO_REPLY assistant messages", () => {
    expect(suppressAgentCompletionNotification(createSession(" NO_REPLY\n"))).toBe(true);
  });

  it("does not suppress normal assistant replies", () => {
    expect(suppressAgentCompletionNotification(createSession("Done shipping the feature."))).toBe(
      false,
    );
  });

  it("does not suppress when NO_REPLY is not the latest message", () => {
    const session = createSession("NO_REPLY");
    session.messages.push({
      id: "user-1",
      role: "user",
      timestamp: 101,
      blocks: [{ type: "text", text: "Thanks" }],
    });

    expect(suppressAgentCompletionNotification(session)).toBe(false);
  });
});
