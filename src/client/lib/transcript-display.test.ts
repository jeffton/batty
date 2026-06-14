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

function assistantWithTool(id: string, toolCallId: string): TranscriptMessageView {
  return view({
    id,
    role: "assistant",
    timestamp: 2,
    blocks: [
      { type: "text", text: `reply ${id}` },
      { type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "echo hi" } },
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
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: `reply ${id}` },
    ],
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
      { showLatestToolToggle: true },
    );

    expect(result.entries.map((entry) => entry.kind)).toEqual([
      "message",
      "message",
      "tool-toggle",
      "message",
      "message",
      "tool-toggle",
    ]);
    expect(result.entries[2]).toMatchObject({
      kind: "tool-toggle",
      sectionKey: "turn:user-1",
      expanded: false,
    });
    expect(result.entries[4]).toMatchObject({ kind: "message" });
    expect(messageBlockCount(result.entries[4])).toBe(2);
    expect(result.entries[5]).toMatchObject({
      kind: "tool-toggle",
      sectionKey: "turn:user-2",
      expanded: true,
    });
  });

  it("does not show a tool toggle when only thinking is hidden", () => {
    const result = buildTranscriptDisplayEntries(
      [user("user-1"), assistantThinkingAndText("assistant-1")],
      toolStates,
      { showLatestToolToggle: true },
    );

    expect(result.entries.map((entry) => entry.kind)).toEqual(["message", "message"]);
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
      "tool-toggle",
      "message",
      "message",
      "message",
    ]);
    expect(result.entries[1]).toMatchObject({
      kind: "tool-toggle",
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
      { showLatestToolToggle: true },
    );

    expect(result.entries.map((entry) => entry.kind)).toEqual([
      "message",
      "tool-toggle",
      "message",
      "message",
      "message",
      "tool-toggle",
      "message",
    ]);
    expect(result.entries[5]).toMatchObject({
      kind: "tool-toggle",
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
      { showLatestToolToggle: false },
    );

    expect(result.entries.map((entry) => entry.kind)).toEqual([
      "message",
      "message",
      "tool-toggle",
      "message",
      "message",
    ]);
    expect(messageBlockCount(result.entries[4])).toBe(2);
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
      { collapsedToolSectionKey: "turn:user-2", showLatestToolToggle: true },
    );

    expect(messageBlockCount(result.entries[4])).toBe(1);
    expect(result.entries[5]).toMatchObject({
      kind: "tool-toggle",
      sectionKey: "turn:user-2",
      expanded: false,
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
      { openToolSectionKey: "turn:user-1" },
    );

    expect(messageBlockCount(result.entries[1])).toBe(2);
    expect(result.entries[2]).toMatchObject({
      kind: "tool-toggle",
      sectionKey: "turn:user-1",
      expanded: true,
    });
  });
});
