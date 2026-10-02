import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Context } from "@earendil-works/chord";
import { fauxAssistantMessage, type JsonObject } from "@earendil-works/pi-ai";
import type { AgentTool, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { createAgentSessionFixture } from "./agent-session-test-fixture";
import { createDurableToolExtension } from "./durable-tools";

const fixtures: Awaited<ReturnType<typeof createAgentSessionFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function setup(options: Parameters<typeof createAgentSessionFixture>[0] = {}) {
  const fixture = await createAgentSessionFixture(options);
  fixtures.push(fixture);
  return fixture;
}

function invocation(callId = "outer") {
  const output = vi.fn();
  const details = vi.fn(async () => {});
  const controller = new AbortController();
  return {
    output,
    details,
    controller,
    api: { callId, output, details } as unknown as ToolExecutionApi,
    context: { abortSignal: controller.signal } as Context,
  };
}

function issue(
  fixture: Awaited<ReturnType<typeof setup>>,
  name: string,
  args: JsonObject,
  id = "outer",
) {
  fixture.session.sdk.agent.state.messages = [
    fauxAssistantMessage([{ type: "toolCall", id, name, arguments: args }]),
  ];
}

describe("SDK durable tool bridge", () => {
  it("snapshots every active tool, including dynamically activated SDK tools", async () => {
    const fixture = await setup();
    const sdk = fixture.session.sdk;
    const extension = createDurableToolExtension(sdk);
    expect(extension.tools?.map((tool) => tool.name)).toEqual(sdk.getActiveToolNames());
    expect(extension.tools?.every((tool) => tool.replay === "unsafe")).toBe(true);
    sdk.setActiveToolsByName(["read"]);
    expect(createDurableToolExtension(sdk).tools?.map((tool) => tool.name)).toEqual(["read"]);
    expect(extension.tools?.length).toBeGreaterThan(1);
  });

  it("runs SDK result hooks and streams snapshot growth and replacements without generation", async () => {
    const fixture = await setup();
    const sdk = fixture.session.sdk;
    const execute = vi.fn(async (_id, _args, signal, update) => {
      expect(signal).toBe(call.controller.signal);
      update({ content: [{ type: "text", text: "hello" }], details: { progress: 1 } });
      update({ content: [{ type: "text", text: "hello world" }], details: { progress: 2 } });
      update({ content: [{ type: "text", text: "rewritten" }], details: { progress: 3 } });
      return { content: [{ type: "text" as const, text: "final" }], details: { original: true } };
    });
    sdk.agent.state.tools = [
      { name: "test", label: "Test", description: "test", parameters: Type.Object({}), execute },
    ];
    const before = vi.fn(async (_context: BeforeToolCallContext) => undefined);
    const usage = {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const after = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "hooked" }],
      details: { artifact: true },
      isError: true,
      usage,
      terminate: true,
    }));
    sdk.agent.beforeToolCall = before;
    sdk.agent.afterToolCall = after;
    const prompt = vi.spyOn(sdk, "prompt");
    const call = invocation();
    issue(fixture, "test", {});
    const tool = createDurableToolExtension(sdk).tools![0]!;
    const result = await tool.execute({}, call.api, call.context);
    expect(call.output.mock.calls.map(([chunk]) => chunk)).toEqual([
      "hello",
      " world",
      "\nrewritten",
    ]);
    expect(call.details).toHaveBeenCalledTimes(3);
    expect(before.mock.calls[0]?.[0]).toMatchObject({ toolCall: { id: "outer", name: "test" } });
    expect(after).toHaveBeenCalledOnce();
    expect(result).toEqual({
      content: [{ type: "text", text: "hooked" }],
      details: { artifact: true },
      isError: true,
      usage,
      control: { terminate: true },
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("refreshes SDK context before finding the issuing assistant", async () => {
    const fixture = await setup();
    const sdk = fixture.session.sdk;
    sdk.agent.state.messages = [];
    const refresh = vi.fn(async () => {
      issue(fixture, "read", { path: "missing.txt" });
    });
    const call = invocation();
    const tool = createDurableToolExtension(sdk, { beforeExecute: refresh }).tools!.find(
      (tool) => tool.name === "read",
    )!;
    expect(await tool.execute({ path: "missing.txt" }, call.api, call.context)).toMatchObject({
      isError: true,
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("retains cancellation artifacts and ignores updates after execution settles", async () => {
    const fixture = await setup();
    const sdk = fixture.session.sdk;
    const call = invocation();
    call.details.mockImplementation(async () => {
      await Promise.resolve();
      if (call.controller.signal.aborted) throw new Error("Progress context aborted");
    });
    let lateUpdate!: NonNullable<Parameters<AgentTool["execute"]>[3]>;
    sdk.agent.state.tools = [
      {
        name: "cancel",
        label: "Cancel",
        description: "cancel",
        parameters: Type.Object({}),
        async execute(_id, _args, signal, update) {
          lateUpdate = update!;
          update!({
            content: [{ type: "text", text: "completed write" }],
            details: { progress: 1 },
          });
          call.controller.abort();
          expect(signal!.aborted).toBe(true);
          return {
            content: [{ type: "text", text: "Operation aborted" }],
            details: { battyFileChanges: [{ path: "written.txt", after: "written" }] },
            isError: true,
          };
        },
      },
    ];
    issue(fixture, "cancel", {});
    const recordArtifacts = vi.fn(async () => {});
    const result = await createDurableToolExtension(sdk, { recordArtifacts }).tools![0]!.execute(
      {},
      call.api,
      call.context,
    );
    expect(recordArtifacts).toHaveBeenCalledWith(
      "outer",
      {
        battyFileChanges: [{ path: "written.txt", after: "written" }],
      },
      call.api.taskId,
    );
    expect(result).toMatchObject({
      isError: true,
      details: { battyFileChanges: [{ path: "written.txt", after: "written" }] },
    });
    lateUpdate({ content: [{ type: "text", text: "late" }], details: { progress: 2 } });
    expect(call.output.mock.calls).toEqual([["completed write"]]);
    expect(call.details).toHaveBeenCalledOnce();
  });

  it("exposes preparation to the harness without applying it twice", async () => {
    const fixture = await setup();
    const sdk = fixture.session.sdk;
    const prepare = vi.fn((args: unknown) => ({ value: (args as { value: number }).value + 1 }));
    const execute = vi.fn(async (_id: string, args: unknown) => ({ content: [], details: args }));
    sdk.agent.state.tools = [
      {
        name: "prepared",
        label: "Prepared",
        description: "prepared",
        parameters: Type.Object({ value: Type.Number() }),
        prepareArguments: prepare,
        execute,
      },
    ];
    issue(fixture, "prepared", { value: 1 });
    const call = invocation();
    const tool = createDurableToolExtension(sdk).tools![0]!;
    const args = tool.prepareArguments!({ value: 1 });
    expect(await tool.execute(args, call.api, call.context)).toMatchObject({
      details: { value: 2 },
      isError: false,
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toEqual({ value: 2 });
  });

  it("honors blocked calls and preserves thrown failures through the result hook", async () => {
    const fixture = await setup();
    const sdk = fixture.session.sdk;
    const execute = vi.fn(async () => {
      throw new Error("failed");
    });
    sdk.agent.state.tools = [
      { name: "test", label: "Test", description: "test", parameters: Type.Object({}), execute },
    ];
    issue(fixture, "test", {});
    const call = invocation();
    const after = vi.fn(async () => undefined);
    sdk.agent.beforeToolCall = async () => ({ block: true, reason: "denied", terminate: true });
    sdk.agent.afterToolCall = after;
    const tool = createDurableToolExtension(sdk).tools![0]!;
    expect(await tool.execute({}, call.api, call.context)).toMatchObject({
      content: [{ text: "denied" }],
      isError: true,
      control: { terminate: true },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    sdk.agent.beforeToolCall = undefined;
    expect(await tool.execute({}, call.api, call.context)).toMatchObject({
      content: [{ text: "failed" }],
      isError: true,
    });
    expect(after).toHaveBeenCalledOnce();
  });

  it("checks end-turn after each tool completes, including error results", async () => {
    const fixture = await setup();
    const sdk = fixture.session.sdk;
    let end = false;
    sdk.agent.state.tools = ["first", "second"].map((name): AgentTool => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      async execute() {
        end = true;
        return { content: [], details: {}, isError: true };
      },
    }));
    issue(fixture, "first", {});
    const tools = createDurableToolExtension(sdk, { shouldEndTurn: () => end }).tools!;
    for (const tool of tools) {
      const call = invocation(tool.name);
      expect(await tool.execute({}, call.api, call.context)).toMatchObject({
        isError: true,
        control: { terminate: true },
      });
    }
  });

  it.each([false, true])(
    "preserves nested codemode hooks and tracked write artifacts (cancel=%s)",
    async (cancel) => {
      const call = invocation();
      const events: { name: string; parent?: string }[] = [];
      const fixture = await setup({
        extensionFactories: [
          (pi) => {
            pi.on("tool_result", (event) => {
              events.push({ name: event.toolName, parent: event.parentToolCallId });
              if (cancel && event.toolName === "write") call.controller.abort();
            });
          },
        ],
      });
      const args = {
        code: 'await tools.write({path:"nested.txt",content:"written\\n"}); text("done");',
      };
      issue(fixture, "codemode", args);
      const recordArtifacts = vi.fn(async () => {});
      const tool = createDurableToolExtension(fixture.session.sdk, { recordArtifacts }).tools!.find(
        (tool) => tool.name === "codemode",
      )!;
      const result = await tool.execute(args, call.api, call.context);
      expect(recordArtifacts).toHaveBeenCalledWith(
        "outer",
        expect.objectContaining({ battyFileChanges: expect.any(Array) }),
        call.api.taskId,
      );
      if (!cancel) expect(result.isError).toBe(false);
      expect(await fs.readFile(path.join(fixture.root, "nested.txt"), "utf8")).toBe("written\n");
      expect(events).toEqual([
        { name: "write", parent: "outer" },
        { name: "codemode", parent: undefined },
      ]);
      expect(result.details).toMatchObject({
        battyFileChanges: [
          { before: null, after: "written\n", patch: expect.stringContaining("+written") },
        ],
      });
    },
  );
});
