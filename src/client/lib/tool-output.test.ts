import { describe, expect, it } from "vite-plus/test";
import { createHeadView, createTailView, createToolOutputView } from "@/client/lib/tool-output";

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
    const text = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n");

    expect(createHeadView(text, 5)).toEqual({
      text: ["line-1", "line-2", "line-3", "line-4", "line-5"].join("\n"),
      hiddenLineCount: 25,
      totalLineCount: 30,
      isTrimmed: true,
    });
  });
});

describe("createToolOutputView", () => {
  it("uses the shared direction for each tool", () => {
    const text = "first\nmiddle\nlast";

    expect(createToolOutputView("web-search", text, 1).text).toBe("first");
    expect(createToolOutputView("bash", text, 1).text).toBe("last");
  });
});

describe("createTailView", () => {
  it("returns the original text when it fits within the window", () => {
    expect(createTailView("one\ntwo\nthree", 3)).toEqual({
      text: "one\ntwo\nthree",
      hiddenLineCount: 0,
      totalLineCount: 3,
      isTrimmed: false,
    });
  });

  it("keeps only the last lines once the output exceeds the window", () => {
    const text = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n");

    expect(createTailView(text, 5)).toEqual({
      text: ["line-26", "line-27", "line-28", "line-29", "line-30"].join("\n"),
      hiddenLineCount: 25,
      totalLineCount: 30,
      isTrimmed: true,
    });
  });

  it("counts a trailing newline as part of the streamed output", () => {
    expect(createTailView("one\ntwo\n", 2)).toEqual({
      text: "two\n",
      hiddenLineCount: 1,
      totalLineCount: 3,
      isTrimmed: true,
    });
  });
});
