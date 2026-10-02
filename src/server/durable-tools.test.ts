import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Context } from "@earendil-works/chord";
import { fauxAssistantMessage, type JsonObject } from "@earendil-works/pi-ai";
import {
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TaskId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { createTrackedFileTools } from "./agent-file-changes";
import { createDurableToolExtension } from "./durable-tools";
import { SessionResources, type SessionResourceCallbacks } from "./session-resources";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function definition(
  name: string,
  execute: ToolDefinition<any>["execute"],
  extra: Partial<ToolDefinition<any>> = {},
): ToolDefinition<any> {
  return { name, label: name, description: name, parameters: Type.Object({}), execute, ...extra };
}
async function setup(
  tools: ToolDefinition<any>[],
  factories: ExtensionFactory[] = [],
  execution: "parallel" | "sequential" = "parallel",
) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "batty-resources-"));
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: factories,
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    refreshOnCreate: false,
    modelsPath: null,
    authPath: path.join(cwd, "auth.json"),
    modelsStorePath: path.join(cwd, "models.json"),
  });
  const store = {
    getCwd: () => cwd,
    getSessionId: () => "test",
    getSessionFile: () => undefined,
    getSessionName: () => undefined,
    getEntries: () => [],
    getBranch: () => [],
  } as unknown as SessionResourcesOptionsStore;
  const host = new SessionResources({
    cwd,
    store,
    resourceLoader,
    settingsManager,
    modelRuntime,
    tools,
    toolExecution: execution,
    activeToolNames: [...tools.map((tool) => tool.name), "codemode", "tool_search"],
  });
  const emit = vi.fn();
  const recordArtifacts = vi.fn(async () => {});
  let messages = [
    fauxAssistantMessage([
      { type: "toolCall", id: "outer", name: tools[0]?.name ?? "codemode", arguments: {} },
    ]),
  ];
  const callbacks: SessionResourceCallbacks = {
    actions: {
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      appendEntry: vi.fn(),
      setSessionName: vi.fn(),
      getSessionName: () => undefined,
      setLabel: vi.fn(),
      setModel: async () => true,
      getThinkingLevel: () => "off",
      setThinkingLevel: vi.fn(),
    },
    context: {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      getSignal: () => undefined,
      abort: vi.fn(),
      hasPendingMessages: () => false,
      shutdown: vi.fn(),
      getContextUsage: () => undefined,
      compact: vi.fn(),
    },
    getMessages: () => messages,
    emit,
  };
  host.bind(callbacks);
  await host.start();
  cleanups.push(async () => {
    await host.dispose();
    await fs.rm(cwd, { recursive: true, force: true });
  });
  return {
    host,
    cwd,
    emit,
    recordArtifacts,
    callbacks,
    issue: (name: string, args: Record<string, unknown>, id = "outer") => {
      messages = [
        fauxAssistantMessage([{ type: "toolCall", id, name, arguments: args as JsonObject }]),
      ];
    },
  };
}
type SessionResourcesOptionsStore = ConstructorParameters<typeof SessionResources>[0]["store"];
function invocation(callId = "outer", taskId = "task-outer") {
  const output = vi.fn();
  const details = vi.fn(async () => {});
  const controller = new AbortController();
  return {
    output,
    details,
    controller,
    api: { callId, taskId, output, details } as unknown as ToolExecutionApi,
    context: { abortSignal: controller.signal } as Context,
  };
}
function tool(host: SessionResources, name: string) {
  return createDurableToolExtension(host).tools!.find((tool) => tool.name === name)!;
}

describe("standalone Durable tool resources", () => {
  it("snapshots declarations and activates tools without an SDK execution engine", async () => {
    const { host } = await setup([
      definition("one", async () => ({ content: [], details: {} })),
      definition("two", async () => ({ content: [], details: {} })),
    ]);
    const snapshot = createDurableToolExtension(host);
    expect(snapshot.tools?.map((tool) => tool.name)).toEqual(["one", "two"]);
    expect(snapshot.tools?.every((tool) => tool.replay === "unsafe")).toBe(true);
    await host.setActiveToolsByName(["one"]);
    expect(createDurableToolExtension(host).tools?.map((tool) => tool.name)).toEqual(["one"]);
    expect(snapshot.tools).toHaveLength(2);
  });

  it("runs extension hooks and streams snapshot growth and replacements", async () => {
    const after = vi.fn();
    const { host } = await setup(
      [
        definition("test", async (_id, _args, signal, update) => {
          expect(signal).toBe(call.controller.signal);
          update?.({ content: [{ type: "text", text: "hello" }], details: { progress: 1 } });
          update?.({ content: [{ type: "text", text: "hello world" }], details: { progress: 2 } });
          update?.({ content: [{ type: "text", text: "rewritten" }], details: { progress: 3 } });
          return { content: [{ type: "text", text: "final" }], details: {} };
        }),
      ],
      [
        (pi) => {
          pi.on("tool_result", () => {
            after();
            return {
              content: [{ type: "text", text: "hooked" }],
              details: { hooked: true },
              isError: true,
            };
          });
        },
      ],
    );
    const call = invocation();
    expect(await tool(host, "test").execute({}, call.api, call.context)).toMatchObject({
      content: [{ text: "hooked" }],
      details: { hooked: true },
      isError: true,
    });
    expect(call.output.mock.calls).toEqual([["hello"], [" world"], ["\nrewritten"]]);
    expect(call.details).toHaveBeenCalledTimes(3);
    expect(after).toHaveBeenCalledOnce();
  });

  it("prepares harness arguments once and preserves blocked/failing results", async () => {
    let block = false;
    const prepare = vi.fn((args: unknown) => ({ value: (args as { value: number }).value + 1 }));
    const execute = vi.fn(async (_id: string, args: unknown) => {
      if ((args as { value: number }).value === 3) throw new Error("failed");
      return { content: [], details: args };
    });
    const { host } = await setup(
      [
        definition("prepared", execute, {
          parameters: Type.Object({ value: Type.Number() }),
          prepareArguments: prepare,
        }),
      ],
      [
        (pi) => {
          pi.on("tool_call", () =>
            block ? { block: true, reason: "denied", terminate: true } : undefined,
          );
        },
      ],
    );
    const call = invocation();
    const selected = tool(host, "prepared");
    const args = selected.prepareArguments!({ value: 1 });
    expect(await selected.execute(args, call.api, call.context)).toMatchObject({
      details: { value: 2 },
      isError: false,
    });
    expect(prepare).toHaveBeenCalledOnce();
    block = true;
    expect(await selected.execute({ value: 2 }, call.api, call.context)).toMatchObject({
      isError: true,
      control: { terminate: true },
    });
    expect(execute).toHaveBeenCalledOnce();
    block = false;
    expect(await selected.execute({ value: 3 }, call.api, call.context)).toMatchObject({
      content: [{ text: "failed" }],
      isError: true,
    });
  });

  it("retains completed artifacts on cancellation using the Durable task id", async () => {
    const call = invocation();
    const { host } = await setup([
      definition("cancel", async () => {
        call.controller.abort();
        return {
          content: [],
          details: { battyFileChanges: [{ path: "written.txt" }] },
          isError: true,
        };
      }),
    ]);
    const recordArtifacts = vi.fn(async () => {});
    await createDurableToolExtension(host, { recordArtifacts }).tools![0]!.execute(
      {},
      call.api,
      call.context,
    );
    expect(recordArtifacts).toHaveBeenCalledWith(
      "outer",
      { battyFileChanges: [{ path: "written.txt" }] },
      "task-outer",
    );
  });

  it("ignores updates after a tool settles", async () => {
    let lateUpdate: Parameters<ToolDefinition<any>["execute"]>[3];
    const { host } = await setup([
      definition("late", async (_id, _args, _signal, update) => {
        lateUpdate = update;
        update?.({ content: [{ type: "text", text: "working" }], details: {} });
        return { content: [], details: {} };
      }),
    ]);
    const call = invocation();
    await tool(host, "late").execute({}, call.api, call.context);
    lateUpdate?.({ content: [{ type: "text", text: "late" }], details: {} });
    expect(call.output.mock.calls).toEqual([["working"]]);
    expect(call.details).toHaveBeenCalledOnce();
  });

  it("uses builtin codemode loadout, deferred tools, nested hooks/events and receipts", async () => {
    const hooks: string[] = [];
    const { host, emit, issue } = await setup(
      [
        definition(
          "deferred",
          async (_id, args) => ({ content: [{ type: "text", text: "nested" }], details: args }),
          { exposure: "deferred" },
        ),
      ],
      [
        createCodemodeExtension({ models: false }),
        createToolSearchExtension(),
        (pi) => {
          pi.on("tool_call", (event) => {
            if (event.parentToolCallId) hooks.push(event.parentToolCallId);
          });
        },
      ],
    );
    await host.setActiveToolsByName(["codemode"]);
    expect(host.callableToolNames).toContain("deferred");
    const args = { code: "return await tools.deferred({});" };
    issue("codemode", args);
    const call = invocation();
    const result = await tool(host, "codemode").execute(args, call.api, call.context);
    expect(result.isError).toBe(false);
    expect((result.details as { nestedCalls: unknown }).nestedCalls).toMatchObject({
      calls: [{ id: "outer/1", name: "deferred", status: "ok" }],
      complete: true,
    });
    expect(hooks).toEqual(["outer"]);
    expect(emit.mock.calls.map(([event]) => event)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_execution_start", parentToolCallId: "outer" }),
        expect.objectContaining({ type: "tool_execution_end", parentToolCallId: "outer" }),
      ]),
    );
  });

  it("keeps codemode-only declarations separate from callable executables across reload", async () => {
    const { host } = await setup(
      [definition("leaf", async () => ({ content: [], details: {} }))],
      [createCodemodeExtension({ models: false, mode: "only" })],
    );
    expect(host.activeToolNames).toContain("leaf");
    expect(host.declaredTools.map((tool) => tool.name)).toEqual(["codemode"]);
    expect(host.callableToolNames).toContain("leaf");
    expect(host.systemPrompt).toContain("codemode");
    await host.reload();
    expect(host.declaredTools.map((tool) => tool.name)).toEqual(["codemode"]);
  });

  it("refreshes dynamically registered tools and surfaces deferred persistence failures", async () => {
    const changed = vi.fn(async () => {});
    const { host, callbacks } = await setup(
      [],
      [
        (pi) => {
          pi.on("session_start", () => {
            pi.registerTool(definition("dynamic", async () => ({ content: [], details: {} })));
          });
        },
      ],
    );
    expect(host.declaredTools.map((tool) => tool.name)).toContain("dynamic");
    host.bind({ ...callbacks, toolsChanged: changed });
    await host.setActiveToolsByName([]);
    expect(changed).toHaveBeenCalled();
    host.trackOperation(Promise.reject(new Error("commit failed")));
    await expect(host.flushOperations()).rejects.toThrow("Extension operations failed");
    await host.flushOperations();
  });

  it("serializes nested calls without deadlocking recursive calls", async () => {
    let running = 0;
    let maximum = 0;
    const leaf = definition(
      "leaf",
      async () => {
        running++;
        maximum = Math.max(maximum, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        return { content: [], details: {} };
      },
      { exposure: "deferred" },
    );
    const parent = definition("parent", async (_id, _args, _signal, _update, ctx) => {
      await Promise.all([ctx.executeTool("leaf", {}), ctx.executeTool("leaf", {})]);
      return { content: [], details: {} };
    });
    const { host } = await setup([parent, leaf], [], "sequential");
    const call = invocation();
    expect((await tool(host, "parent").execute({}, call.api, call.context)).isError).toBe(false);
    expect(maximum).toBe(1);
  });

  it("attributes late cancelled nested writes to the exact task when root call IDs are reused", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const [write] = createTrackedFileTools("unused");
    const delayedWrite = {
      ...write!,
      async execute(
        id: string,
        args: any,
        _signal: AbortSignal | undefined,
        update: any,
        ctx: any,
      ) {
        if (args.content === "old") {
          started();
          await gate;
        }
        // Model a filesystem operation that completed after cancellation was requested.
        return write!.execute(id, args, undefined, update, ctx);
      },
    };
    const parent = definition(
      "parent",
      async (_id, args, _signal, _update, ctx) => {
        const input = args as { path: string; content: string };
        await ctx.executeTool(delayedWrite.name, input);
        return { content: [], details: {} };
      },
      { parameters: Type.Object({ path: Type.String(), content: Type.String() }) },
    );
    const { host, cwd } = await setup([parent, delayedWrite]);
    const receipts = vi.fn(async (_callId: string, _details: unknown, _taskId: TaskId) => {});
    const selected = createDurableToolExtension(host, { recordArtifacts: receipts }).tools!.find(
      (tool) => tool.name === "parent",
    )!;
    const old = invocation();
    const fresh = invocation("outer", "task-fresh");
    const oldExecution = selected.execute(
      { path: "old.txt", content: "old" },
      old.api,
      old.context,
    );
    await ready;
    old.controller.abort();
    const freshResult = await selected.execute(
      { path: "fresh.txt", content: "fresh" },
      fresh.api,
      fresh.context,
    );
    expect(receipts).toHaveBeenCalledWith(
      "outer",
      expect.objectContaining({ battyFileChanges: expect.any(Array) }),
      "task-fresh",
    );
    release();
    const oldResult = await oldExecution;
    expect(receipts).toHaveBeenCalledTimes(2);
    expect(receipts.mock.calls.map((call) => call[2])).toEqual(["task-fresh", "task-outer"]);
    expect((freshResult.details as any).nestedCalls.calls).toHaveLength(1);
    expect((oldResult.details as any).nestedCalls.calls).toHaveLength(1);
    expect(await fs.readFile(path.join(cwd, "old.txt"), "utf8")).toBe("old");
  });

  it("activates initial declarable extension defaults but respects inactive and deferred tools", async () => {
    const { host } = await setup(
      [],
      [
        (pi) => {
          pi.registerTool(definition("direct", async () => ({ content: [], details: {} })));
          pi.registerTool(
            definition("model", async () => ({ content: [], details: {} }), {
              exposure: "model-only",
            }),
          );
          pi.registerTool(
            definition("inactive", async () => ({ content: [], details: {} }), {
              defaultActive: false,
            }),
          );
          pi.registerTool(
            definition("deferred", async () => ({ content: [], details: {} }), {
              exposure: "deferred",
            }),
          );
        },
      ],
    );
    expect(host.activeToolNames).toEqual(["direct", "model"]);
    expect(host.callableToolNames).toEqual(["direct", "deferred"]);
  });

  it("records nested tracked file artifacts separately from the parent result", async () => {
    const { cwd } = await setup([], [createCodemodeExtension({ models: false })]);
    const tracked = createTrackedFileTools(cwd);
    // A fresh host gets ordinary tracked ToolDefinitions, just like the production factory.
    const second = await setup(tracked, [createCodemodeExtension({ models: false })]);
    const args = { code: "return await tools.write({path:'written.txt',content:'hello'});" };
    second.issue("codemode", args);
    const call = invocation();
    await createDurableToolExtension(second.host, { recordArtifacts: second.recordArtifacts })
      .tools!.find((tool) => tool.name === "codemode")!
      .execute(args, call.api, call.context);
    expect(second.recordArtifacts).toHaveBeenCalledWith(
      "outer",
      expect.objectContaining({ battyFileChanges: expect.any(Array) }),
      "task-outer",
    );
    expect(await fs.readFile(path.join(second.cwd, "written.txt"), "utf8")).toBe("hello");
  });
});
