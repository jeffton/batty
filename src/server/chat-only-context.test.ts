import { describe, expect, it } from "vite-plus/test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { filterMessagesForChatOnlyContext } from "./chat-only-context";

describe("filterMessagesForChatOnlyContext", () => {
  it("copies only user and assistant chat content", () => {
    const messages = [
      { role: "user", content: "Question", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Reasoning" },
          { type: "text", text: "Answer" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: 3,
      },
      { role: "custom", customType: "notice", content: "Details", timestamp: 4 },
    ] as AgentMessage[];

    expect(filterMessagesForChatOnlyContext(messages)).toEqual([
      messages[0],
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "Answer" }],
      }),
    ]);
  });
});
