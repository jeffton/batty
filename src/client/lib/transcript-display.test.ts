import { describe, expect, it } from "vite-plus/test";
import { buildTranscriptDisplayEntries } from "@/client/lib/transcript-display";
import type { ToolDisplayState, TranscriptMessageView } from "@/client/lib/transcript";
import type { UiMessage } from "@/shared/types";

function view(message: UiMessage): TranscriptMessageView {
  return { message, toolStatesByCallId: new Map() };
}

function user(id: string): TranscriptMessageView {
  return view({ id, role: "user", timestamp: 1, blocks: [{ type: "text", text: id }] });
}

function detachedCronNotice(id: string): TranscriptMessageView {
  return view({
    id,
    role: "custom",
    timestamp: 1,
    customType: "batty-runtime-notice:cron",
    text: "Cron run completed.",
    data: { cron: { workspaceId: "roy", sessionPath: "/tmp/cron.jsonl" } },
  });
}

function assistantWithTool(id: string, toolCallId: string): TranscriptMessageView {
  return view({
    id,
    role: "assistant",
    timestamp: 2,
    blocks: [
      { type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "echo hi" } },
      { type: "text", text: `reply ${id}` },
    ],
  });
}

function assistantToolOnly(id: string, toolCallId: string): TranscriptMessageView {
  return view({
    id,
    role: "assistant",
    timestamp: 2,
    blocks: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "echo hi" } }],
  });
}

function assistantText(id: string): TranscriptMessageView {
  return view({
    id,
    role: "assistant",
    timestamp: 3,
    blocks: [{ type: "text", text: `reply ${id}` }],
  });
}

function assistantThinkingAndText(id: string): TranscriptMessageView {
  return view({
    id,
    role: "assistant",
    timestamp: 3,
    blocks: [
      { type: "thinking", thinking: "reasoning summary" },
      { type: "text", text: `reply ${id}` },
    ],
  });
}

function assistantThinkingOnly(id: string): TranscriptMessageView {
  return view({
    id,
    role: "assistant",
    timestamp: 3,
    blocks: [{ type: "thinking", thinking: "reasoning summary" }],
  });
}

function assistantThinkingAndImage(id: string): TranscriptMessageView {
  return view({
    id,
    role: "assistant",
    timestamp: 3,
    blocks: [
      { type: "thinking", thinking: "reasoning summary" },
      { type: "image", mimeType: "image/png", url: "/result.png" },
    ],
  });
}

function assistantThinkingError(id: string): TranscriptMessageView {
  return view({
    id,
    role: "assistant",
    timestamp: 3,
    blocks: [{ type: "thinking", thinking: "reasoning summary" }],
    stopReason: "error",
    errorMessage: "Request failed.",
  });
}

function messageBlockCount(entry: unknown): number {
  if (!entry || typeof entry !== "object" || !("kind" in entry) || entry.kind !== "message") {
    return 0;
  }

  const messageEntry = entry as Extract<
    ReturnType<typeof buildTranscriptDisplayEntries>["entries"][number],
    { kind: "message" }
  >;
  return "blocks" in messageEntry.entry.message ? messageEntry.entry.message.blocks.length : 0;
}

const toolStates = new Map<string, ToolDisplayState>([
  ["call-1", { status: "success", resultBlocks: [{ type: "text", text: "one" }] }],
  ["call-2", { status: "success", resultBlocks: [{ type: "text", text: "two" }] }],
]);

describe("buildTranscriptDisplayEntries", () => {
  it("keeps the latest turn expanded and gives every hidden section a toggle", () => {
    const result = buildTranscriptDisplayEntries(
      [
        user("user-1"),
        assistantWithTool("assistant-1", "call-1"),
        user("user-2"),
        assistantWithTool("assistant-2", "call-2"),
      ],
      toolStates,
      { showLatestDetailsToggle: true },
    );

    expect(result.entries.map((entry) => entry.kind)).toEqual([
      "message",
      "message",
      "message",
      "message",
    ]);
    expect(result.entries[1]).toMatchObject({
      kind: "message",
      detailsToggleBeforeReply: { sectionKey: "turn:user-1", expanded: false },
    });
    expect(messageBlockCount(result.entries[3])).toBe(2);
    expect(result.entries[3]).toMatchObject({
      kind: "message",
      detailsToggleBeforeReply: { sectionKey: "turn:user-2", expanded: true },
    });
  });

  it("shows a toggle when a detached cron notice is hidden", () => {
    const result = buildTranscriptDisplayEntries(
      [detachedCronNotice("cron-1"), assistantText("assistant-1")],
      toolStates,
    );

    expect(result.entries.map((entry) => entry.kind)).toEqual(["details-toggle", "message"]);
    expect(result.entries[0]).toMatchObject({
      kind: "details-toggle",
      sectionKey: "turn:cron-1",
      expanded: false,
    });
  });

  it("shows thinking in the expanded latest turn and collapses it with other details", () => {
    const expanded = buildTranscriptDisplayEntries(
      [user("user-1"), assistantThinkingAndText("assistant-1")],
      toolStates,
      { showLatestDetailsToggle: true },
    );

    expect(expanded.entries.map((entry) => entry.kind)).toEqual(["message", "message"]);
    expect(messageBlockCount(expanded.entries[1])).toBe(2);
    expect(expanded.entries[1]).toMatchObject({
      kind: "message",
      detailsToggleBeforeReply: {
        sectionKey: "turn:user-1",
        expanded: true,
      },
    });

    const collapsed = buildTranscriptDisplayEntries(
      [user("user-1"), assistantThinkingAndText("assistant-1")],
      toolStates,
      {
        collapsedDetailsSectionKey: "turn:user-1",
        showLatestDetailsToggle: true,
      },
    );

    expect(collapsed.entries.map((entry) => entry.kind)).toEqual(["message", "message"]);
    expect(messageBlockCount(collapsed.entries[1])).toBe(1);
    expect(collapsed.entries[1]).toMatchObject({
      kind: "message",
      detailsToggleBeforeReply: {
        sectionKey: "turn:user-1",
        expanded: false,
      },
    });
  });

  it.each([
    ["error", assistantThinkingError],
    ["image", assistantThinkingAndImage],
  ])("places expanded and collapsed details toggles before an assistant %s reply", (_, reply) => {
    for (const collapsed of [false, true]) {
      const result = buildTranscriptDisplayEntries(
        [user("user-1"), reply("assistant-1")],
        toolStates,
        {
          collapsedDetailsSectionKey: collapsed ? "turn:user-1" : null,
          showLatestDetailsToggle: true,
        },
      );

      expect(result.entries.map((entry) => entry.kind)).toEqual(["message", "message"]);
      expect(result.entries[1]).toMatchObject({
        kind: "message",
        detailsToggleBeforeReply: { sectionKey: "turn:user-1", expanded: !collapsed },
      });
    }
  });

  it("places the details toggle before an attachment-only reply", () => {
    const attachmentStates = new Map<string, ToolDisplayState>([
      [
        "attachment-1",
        {
          status: "success",
          resultBlocks: [],
          resultDetails: {
            sentFiles: [
              {
                id: "file-1",
                name: "report.md",
                size: 100,
                mimeType: "text/markdown",
                kind: "file",
                downloadUrl: "/report.md",
              },
            ],
          },
        },
      ],
    ]);
    const attachmentReply: TranscriptMessageView = {
      message: {
        id: "assistant-1",
        role: "assistant",
        timestamp: 3,
        blocks: [
          { type: "thinking", thinking: "preparing report" },
          {
            type: "toolCall",
            id: "attachment-1",
            name: "attach-files",
            arguments: { paths: ["report.md"] },
          },
        ],
      },
      toolStatesByCallId: attachmentStates,
    };

    for (const collapsed of [false, true]) {
      const result = buildTranscriptDisplayEntries(
        [user("user-1"), attachmentReply],
        attachmentStates,
        {
          collapsedDetailsSectionKey: collapsed ? "turn:user-1" : null,
          showLatestDetailsToggle: true,
        },
      );

      expect(result.entries.map((entry) => entry.kind)).toEqual(["message", "message"]);
      expect(result.entries[1]).toMatchObject({
        kind: "message",
        detailsToggleBeforeReply: { sectionKey: "turn:user-1", expanded: !collapsed },
      });
    }
  });

  it("keeps a reveal toggle for a collapsed thinking-only historical turn", () => {
    const result = buildTranscriptDisplayEntries(
      [
        user("user-1"),
        assistantThinkingOnly("assistant-1"),
        user("user-2"),
        assistantText("assistant-2"),
      ],
      toolStates,
    );

    expect(result.entries.map((entry) => entry.kind)).toEqual([
      "message",
      "details-toggle",
      "message",
      "message",
    ]);
  });

  it("puts the show toggle after collapsed tool-call-only messages before the reply", () => {
    const result = buildTranscriptDisplayEntries(
      [
        user("user-1"),
        assistantToolOnly("assistant-tools-1", "call-1"),
        assistantToolOnly("assistant-tools-2", "call-2"),
        assistantText("assistant-1"),
        user("user-2"),
        assistantText("assistant-2"),
      ],
      toolStates,
    );

    expect(result.entries.map((entry) => entry.kind)).toEqual([
      "message",
      "details-toggle",
      "message",
      "message",
      "message",
    ]);
    expect(result.entries[1]).toMatchObject({
      kind: "details-toggle",
      sectionKey: "turn:user-1",
      expanded: false,
    });
  });

  it("puts the collapse toggle after latest tool calls before the reply", () => {
    const result = buildTranscriptDisplayEntries(
      [
        user("user-1"),
        assistantToolOnly("assistant-tools-1", "call-1"),
        user("user-2"),
        assistantToolOnly("assistant-tools-2", "call-1"),
        assistantToolOnly("assistant-tools-3", "call-2"),
        assistantText("assistant-2"),
      ],
      toolStates,
      { showLatestDetailsToggle: true },
    );

    expect(result.entries.map((entry) => entry.kind)).toEqual([
      "message",
      "details-toggle",
      "message",
      "message",
      "message",
      "details-toggle",
      "message",
    ]);
    expect(result.entries[5]).toMatchObject({
      kind: "details-toggle",
      sectionKey: "turn:user-2",
      expanded: true,
    });
  });

  it("hides the latest turn toggle while the turn is streaming", () => {
    const result = buildTranscriptDisplayEntries(
      [
        user("user-1"),
        assistantWithTool("assistant-1", "call-1"),
        user("user-2"),
        assistantWithTool("assistant-2", "call-2"),
      ],
      toolStates,
      { showLatestDetailsToggle: false },
    );

    expect(result.entries.map((entry) => entry.kind)).toEqual([
      "message",
      "message",
      "message",
      "message",
    ]);
    expect(result.entries[1]).toMatchObject({
      kind: "message",
      detailsToggleBeforeReply: { sectionKey: "turn:user-1", expanded: false },
    });
    expect(messageBlockCount(result.entries[3])).toBe(2);
    expect(result.entries[3]).not.toHaveProperty("detailsToggleBeforeReply");
  });

  it("collapses the latest turn when it is selected as collapsed", () => {
    const result = buildTranscriptDisplayEntries(
      [
        user("user-1"),
        assistantWithTool("assistant-1", "call-1"),
        user("user-2"),
        assistantWithTool("assistant-2", "call-2"),
      ],
      toolStates,
      { collapsedDetailsSectionKey: "turn:user-2", showLatestDetailsToggle: true },
    );

    expect(messageBlockCount(result.entries[3])).toBe(1);
    expect(result.entries[3]).toMatchObject({
      kind: "message",
      detailsToggleBeforeReply: { sectionKey: "turn:user-2", expanded: false },
    });
  });

  it("opens only the selected old turn", () => {
    const result = buildTranscriptDisplayEntries(
      [
        user("user-1"),
        assistantWithTool("assistant-1", "call-1"),
        user("user-2"),
        assistantWithTool("assistant-2", "call-2"),
      ],
      toolStates,
      { openDetailsSectionKey: "turn:user-1" },
    );

    expect(messageBlockCount(result.entries[1])).toBe(2);
    expect(result.entries[1]).toMatchObject({
      kind: "message",
      detailsToggleBeforeReply: { sectionKey: "turn:user-1", expanded: true },
    });
  });
});
