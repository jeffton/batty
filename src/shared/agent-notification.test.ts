import { describe, expect, it } from "vite-plus/test";
import {
  buildAgentCompletionNotificationContent,
  markdownToNotificationText,
} from "@/shared/agent-notification";
import type { SessionState } from "@/shared/types";

function createSession(markdown: string): SessionState {
  return {
    id: "session-1",
    sessionId: "session-1",
    workspaceId: "batty",
    cwd: "/root/github/batty",
    path: "/root/github/batty/.pi/session.jsonl",
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
