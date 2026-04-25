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

  it("moves attachment-only assistant tool calls into the following assistant response", () => {
    const attachmentAssistant: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-attach",
      role: "assistant",
      timestamp: 3,
      blocks: [
        {
          type: "toolCall",
          id: "attach-1",
          name: "attach-files",
          arguments: { paths: ["report.txt"] },
        },
      ],
    };
    const attachmentResult: Extract<UiMessage, { role: "toolResult" }> = {
      id: "tool-attach",
      role: "toolResult",
      timestamp: 4,
      toolCallId: "attach-1",
      toolName: "attach-files",
      blocks: [{ type: "text", text: "Attached 1 file for the user." }],
      details: {
        sentFiles: [
          {
            id: "file-1",
            name: "report.txt",
            size: 42,
            mimeType: "text/plain",
            kind: "file",
            downloadUrl: "/api/sent-files/file-1?download=1",
          },
        ],
      },
      isError: false,
    };
    const finalAssistant: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-final",
      role: "assistant",
      timestamp: 5,
      blocks: [{ type: "text", text: "Here is the report." }],
    };

    const messages: SessionState["messages"] = [
      attachmentAssistant,
      attachmentResult,
      finalAssistant,
    ];
    const lookup = buildToolStateLookup(messages, []);
    const transcript = buildTranscriptMessages(messages, lookup);

    expect(transcript).toHaveLength(1);
    const transcriptMessage = transcript[0]?.message as Extract<UiMessage, { role: "assistant" }>;
    expect(transcriptMessage.id).toBe("assistant-final");
    expect(transcriptMessage.blocks).toEqual([
      { type: "text", text: "Here is the report." },
      attachmentAssistant.blocks[0],
    ]);
    expect(transcript[0]?.toolStatesByCallId.get("attach-1")?.resultDetails).toEqual(
      attachmentResult.details,
    );
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
