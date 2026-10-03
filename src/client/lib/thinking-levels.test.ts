import { describe, expect, it } from "vite-plus/test";
import { resolveModelThinkingOptions, resolveThinkingOptions } from "@/client/lib/thinking-levels";

describe("resolveThinkingOptions", () => {
  it("uses server-provided thinking levels when available", () => {
    expect(
      resolveThinkingOptions({
        availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
      }),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("returns no options without server-provided levels", () => {
    expect(resolveThinkingOptions({ availableThinkingLevels: [] })).toEqual([]);
    expect(resolveThinkingOptions(undefined)).toEqual([]);
  });

  it("deduplicates explicit levels without inventing new ones", () => {
    expect(resolveThinkingOptions({ availableThinkingLevels: ["high", "xhigh", "high"] })).toEqual([
      "high",
      "xhigh",
    ]);
  });
});

describe("resolveModelThinkingOptions", () => {
  it("uses and deduplicates the selected model's thinking levels", () => {
    expect(resolveModelThinkingOptions({ thinkingLevels: ["minimal", "high", "high"] })).toEqual([
      "minimal",
      "high",
    ]);
  });

  it("returns no options when the model is unavailable", () => {
    expect(resolveModelThinkingOptions(undefined)).toEqual([]);
  });
});
