import { describe, expect, it, vi } from "vite-plus/test";
import { resolveModel } from "./model-resolution";

const model = {
  id: "gpt-5",
  name: "GPT-5",
  provider: "openai",
  input: ["text"],
};

describe("resolveModel", () => {
  it("returns a registered model", () => {
    const getModel = vi.fn(() => model);

    expect(resolveModel({ getModel } as any, "openai/gpt-5")).toBe(model);
    expect(getModel).toHaveBeenCalledWith("openai", "gpt-5");
  });

  it("rejects malformed model ids", () => {
    expect(() => resolveModel({ getModel: vi.fn() } as any, "gpt-5")).toThrow(
      "Invalid model id: gpt-5",
    );
  });

  it("rejects models absent from the runtime", () => {
    expect(() =>
      resolveModel({ getModel: vi.fn(() => undefined) } as any, "openai/missing"),
    ).toThrow("Model not found: openai/missing");
  });
});
