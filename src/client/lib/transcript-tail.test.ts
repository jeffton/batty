import { describe, expect, it } from "vite-plus/test";
import { splitHistoryAndTail } from "@/client/lib/transcript-tail";

describe("splitHistoryAndTail", () => {
  it("keeps the newest entries in the live tail", () => {
    expect(splitHistoryAndTail([1, 2, 3, 4, 5], 2)).toEqual({
      historyEntries: [1, 2, 3],
      tailEntries: [4, 5],
    });
  });

  it("puts everything in the tail when the transcript is shorter than the tail size", () => {
    expect(splitHistoryAndTail([1, 2, 3], 10)).toEqual({
      historyEntries: [],
      tailEntries: [1, 2, 3],
    });
  });

  it("supports an empty tail size", () => {
    expect(splitHistoryAndTail([1, 2, 3], 0)).toEqual({
      historyEntries: [1, 2, 3],
      tailEntries: [],
    });
  });
});
