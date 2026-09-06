import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";
import { toModelOption } from "./pi-service-types";

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...overrides,
  };
}

describe("toModelOption", () => {
  it("exposes off as the only thinking level for non-reasoning models", () => {
    expect(toModelOption(model({ reasoning: false })).thinkingLevels).toEqual(["off"]);
  });

  it("uses Pi's model-specific thinking level capabilities", () => {
    expect(
      toModelOption(
        model({
          thinkingLevelMap: { off: null, xhigh: "xhigh", max: null },
        }),
      ).thinkingLevels,
    ).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  });
});
