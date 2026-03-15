import { describe, expect, it } from "vite-plus/test";
import {
  buildToolStateLookup,
  buildTranscriptMessages,
  toolStatesForMessage,
} from "@/client/lib/transcript";
import type { SessionState, UiMessage } from "@/shared/types";

const assistantMessage: Extract<UiMessage, { role: "assistant" }> = {
  id: "assistant-1",
  role: "assistant",
  timestamp: 1,
  blocks: [
    { type: "text", text: "Running a command" },
    {
      type: "toolCall",
      id: "call-1",
      name: "bash",
      arguments: { command: "git status --short", timeout: 600 },
    },
  ],
};

const toolResultMessage: Extract<UiMessage, { role: "toolResult" }> = {
  id: "tool-1",
  role: "toolResult",
  timestamp: 2,
  toolCallId: "call-1",
  toolName: "bash",
  blocks: [{ type: "text", text: "M src/client/views/ChatView.vue" }],
  isError: false,
};

describe("transcript tool state merging", () => {
  it("hides referenced tool results and attaches the final result to the tool call", () => {
    const messages: SessionState["messages"] = [assistantMessage, toolResultMessage];
    const lookup = buildToolStateLookup(messages, []);
    const transcript = buildTranscriptMessages(messages, lookup);

    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.message).toEqual(assistantMessage);
    expect(transcript[0]?.toolStatesByCallId.get("call-1")).toEqual({
      status: "success",
      resultBlocks: [{ type: "text", text: "M src/client/views/ChatView.vue" }],
      resultDetails: undefined,
    });
  });

  it("prefers active tool output while a tool is still running", () => {
    const messages: SessionState["messages"] = [assistantMessage, toolResultMessage];
    const lookup = buildToolStateLookup(messages, [
      {
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "git status --short", timeout: 600 },
        blocks: [{ type: "text", text: "still streaming" }],
        status: "running",
        isError: false,
      },
    ]);

    expect(toolStatesForMessage(assistantMessage, lookup.toolStatesByCallId).get("call-1")).toEqual(
      {
        status: "running",
        resultBlocks: [{ type: "text", text: "still streaming" }],
        resultDetails: undefined,
      },
    );
  });
});
