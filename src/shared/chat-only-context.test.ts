import { describe, expect, it } from "vite-plus/test";
import {
  chatOnlyBlocks,
  isTranscriptDetailsBlock,
  isTranscriptDetailsMessageRole,
} from "./chat-only-context";

describe("chat-only transcript policy", () => {
  it("classifies the same messages and blocks hidden in transcript details", () => {
    expect(isTranscriptDetailsMessageRole("toolResult")).toBe(true);
    expect(isTranscriptDetailsMessageRole("custom")).toBe(true);
    expect(isTranscriptDetailsMessageRole("assistant")).toBe(false);
    expect(isTranscriptDetailsBlock({ type: "thinking" })).toBe(true);
    expect(isTranscriptDetailsBlock({ type: "toolCall" })).toBe(true);
    expect(isTranscriptDetailsBlock({ type: "text" })).toBe(false);
  });

  it("keeps user chat and strips assistant transcript details", () => {
    const user = [{ type: "text", text: "Question" }];
    expect(chatOnlyBlocks("user", user)).toEqual(user);
    expect(
      chatOnlyBlocks("assistant", [
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "Answer" },
        { type: "toolCall", id: "call-1" },
      ]),
    ).toEqual([{ type: "text", text: "Answer" }]);
    expect(chatOnlyBlocks("toolResult", [{ type: "text", text: "output" }])).toBeUndefined();
    expect(chatOnlyBlocks("assistant", [{ type: "text", text: "NO_REPLY" }])).toBeUndefined();
  });
});
