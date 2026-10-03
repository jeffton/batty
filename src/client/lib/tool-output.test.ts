import { describe, expect, it } from "vite-plus/test";
import { createHeadView, createToolOutputView } from "@/client/lib/tool-output";
import type { TruncatedToolName } from "@/shared/pi-tools";

describe("createHeadView", () => {
  it("returns the original text when it fits within the window", () => {
    expect(createHeadView("one\ntwo\nthree", 3)).toEqual({
      text: "one\ntwo\nthree",
      hiddenLineCount: 0,
      totalLineCount: 3,
      isTrimmed: false,
    });
  });

  it("keeps only the first lines once the output exceeds the window", () => {
    expect(createHeadView("one\ntwo\nthree", 2)).toEqual({
      text: "one\ntwo",
      hiddenLineCount: 1,
      totalLineCount: 3,
      isTrimmed: true,
    });
  });
});

describe("createToolOutputView", () => {
  it.each<[TruncatedToolName, string]>([
    ["bash", "last"],
    ["powershell", "last"],
    ["write", "last"],
    ["read", "first"],
    ["cron", "first"],
    ["codemode", "first"],
    ["web-search", "first"],
    ["browser", "first"],
    ["grep", "first"],
    ["find", "first"],
  ])("keeps the relevant end of %s output", (tool, text) => {
    expect(createToolOutputView(tool, "first\nmiddle\nlast", 1)).toEqual({
      text,
      hiddenLineCount: 2,
      totalLineCount: 3,
      isTrimmed: true,
    });
  });

  it("preserves short output including its line endings", () => {
    expect(createToolOutputView("bash", "one\r\ntwo\rthree", 3)).toEqual({
      text: "one\r\ntwo\rthree",
      hiddenLineCount: 0,
      totalLineCount: 3,
      isTrimmed: false,
    });
  });

  it("normalizes line endings and counts a trailing newline in streamed output", () => {
    expect(createToolOutputView("bash", "one\r\ntwo\r\n", 2)).toEqual({
      text: "two\n",
      hiddenLineCount: 1,
      totalLineCount: 3,
      isTrimmed: true,
    });
  });
});
