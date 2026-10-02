import { describe, expect, it, vi } from "vite-plus/test";
import { prepareDurablePrompt, type DurablePromptSdk } from "./durable-prompt-preflight";

function makeSdk(overrides: Partial<DurablePromptSdk> = {}) {
  const runner = {
    getCommand: vi.fn(
      (
        _name: string,
      ): { handler: (args: string, context: unknown) => void | Promise<void> } | undefined =>
        undefined,
    ),
    createCommandContext: vi.fn(() => ({
      getSystemPromptOptions: () => ({ cwd: "/workspace", selectedTools: ["read"] }),
    })),
    createContext: vi.fn(() => ({
      cwd: "/workspace",
      getSystemPromptOptions: () => ({ cwd: "/workspace", selectedTools: ["read"] }),
    })),
    emitInput: vi.fn(
      async (
        text: string,
      ): Promise<
        | { action: "handled" }
        | {
            action: "transform";
            text: string;
            images?: import("@earendil-works/pi-ai").ImageContent[];
          }
        | { action: "continue" }
      > => {
        void text;
        return { action: "continue" };
      },
    ),
    emitBeforeAgentStart: vi.fn(async () => ({
      messages: [{ customType: "hook-note", content: [{ type: "text", text: "hook" }] }],
      systemPromptOptions: { forceSystemPrompt: "hook system" },
    })),
  };
  const sdk = {
    extensionRunner: runner,
    promptTemplates: [{ name: "review", content: "Review $1, ${2:-everything}: $@" }],
    systemPrompt: "base system",
    model: { provider: "test" },
    modelRuntime: {
      hasConfiguredAuth: () => true,
      checkAuth: async () => undefined,
      isUsingOAuth: () => false,
    },
    ...overrides,
  } as unknown as DurablePromptSdk;
  return { sdk, runner };
}

describe("prepareDurablePrompt", () => {
  it("runs input transforms, expands templates, and returns before-agent-start changes", async () => {
    const { sdk, runner } = makeSdk();
    runner.emitInput.mockImplementation(async (text) => ({
      action: "transform",
      text: `${text}!`,
    }));

    const result = await prepareDurablePrompt(sdk, '/review "API compatibility" focus');

    expect(result).toMatchObject({
      text: "Review API compatibility, focus!: API compatibility focus!",
      handled: false,
      systemPrompt: "hook system",
      messages: [{ customType: "hook-note" }],
    });
    expect(runner.emitBeforeAgentStart).toHaveBeenCalledWith(
      "Review API compatibility, focus!: API compatibility focus!",
      undefined,
      { cwd: "/workspace", selectedTools: ["read"], forceSystemPrompt: "base system" },
    );
  });

  it("returns handled without running later stages", async () => {
    const { sdk, runner } = makeSdk();
    runner.emitInput.mockResolvedValue({ action: "handled" });

    await expect(prepareDurablePrompt(sdk, "consume me")).resolves.toMatchObject({ handled: true });
    expect(runner.emitBeforeAgentStart).not.toHaveBeenCalled();
  });

  it("runs a registered slash command without invoking input hooks", async () => {
    const { sdk, runner } = makeSdk();
    const handler = vi.fn(async () => undefined);
    runner.getCommand.mockReturnValue({ handler });

    await expect(prepareDurablePrompt(sdk, "/deploy now")).resolves.toMatchObject({
      handled: true,
    });
    expect(handler).toHaveBeenCalledWith("now", expect.anything());
    expect(runner.emitInput).not.toHaveBeenCalled();
  });

  it("rejects promptly on cancellation even when an extension hook ignores cancellation", async () => {
    const { sdk, runner } = makeSdk();
    runner.emitInput.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const operations: Promise<unknown>[] = [];
    const pending = prepareDurablePrompt(sdk, "slow", {
      signal: controller.signal,
      onOperation: (operation) => operations.push(operation),
    });
    expect(operations).toHaveLength(1);
    controller.abort(new Error("cancelled"));

    await expect(pending).rejects.toThrow("cancelled");
    expect(runner.emitBeforeAgentStart).not.toHaveBeenCalled();
  });

  it("checks authentication before returning an admitted prompt", async () => {
    const { sdk, runner } = makeSdk({
      modelRuntime: {
        hasConfiguredAuth: () => false,
        checkAuth: async () => undefined,
        isUsingOAuth: () => false,
      },
    });

    await expect(prepareDurablePrompt(sdk, "hello")).rejects.toThrow("No API key found");
    expect(runner.emitInput).toHaveBeenCalled();
  });
});
