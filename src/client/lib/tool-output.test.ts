import { describe, expect, it } from "vite-plus/test";
import { createTailView } from "@/client/lib/tool-output";

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
