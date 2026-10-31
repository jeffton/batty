// @vitest-environment node
import { afterEach, expect, it } from "vite-plus/test";
import { Type } from "typebox";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { Page } from "patchright";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { createCodemodeTool } from "./codemode";
import { createCodemodeAdapters } from "./codemode-native";
import type { McpService } from "./mcp-service";
import { BrowserService } from "./browser-service";
import { browserSessionDirectory } from "./browser-persistence";
import { removeBrowserIsolation } from "./browser-isolation";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const mcp = { structuredResult: () => undefined } as unknown as McpService;

it("joins real nested browser recovery before a sandbox timeout returns, preventing delayed mutations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-codemode-browser-cancel-"));
  const service = new BrowserService(undefined, 4, root);
  let evaluationStarted!: () => void;
  const entered = new Promise<void>((resolve) => (evaluationStarted = resolve));
  const website = http.createServer((request, response) => {
    if (request.url === "/started") evaluationStarted();
    response.end("<h1>Ready</h1>");
  });
  cleanups.push(async () => {
    await service.closeSession("worker");
    await service.dispose();
    website.closeAllConnections();
    await new Promise<void>((resolve) => website.close(() => resolve()));
    await removeBrowserIsolation(browserSessionDirectory(root, "worker"));
    await fs.rm(root, { recursive: true, force: true });
  });
  website.listen(0, "127.0.0.1");
  await once(website, "listening");
  const url = `http://127.0.0.1:${(website.address() as { port: number }).port}/`;
  await service.execute("worker", { action: "open", url });
  await service.execute("worker", { action: "open", url, newPage: true });
  const pages = (
    service as unknown as {
      sessions: Map<string, { pages: Map<string, Page> }>;
    }
  ).sessions.get("worker")!.pages;
  const survivor = pages.get("page-1")!;
  const target = pages.get("page-2")!;
  let harness!: Harness;
  let allTools: ToolRegistration[] = [];
  let closedWhenAbortReturned = false;
  let closedWhenCodemodeReturned = false;
  let codemodeTimedOut = false;
  const codemode = createCodemodeTool(
    async () => allTools,
    new Set(),
    async (id) => {
      await harness.abortTask(id, BACKGROUND_CONTEXT);
      // Inspect the real target immediately: querying through execute() could wait
      // behind unfinished cleanup and conceal an early abortTask return.
      closedWhenAbortReturned = target.isClosed() && !survivor.isClosed();
    },
  );
  const executeCodemode = codemode.execute;
  codemode.execute = async (args, api, ctx) => {
    const result = await executeCodemode(args, api, ctx);
    closedWhenCodemodeReturned = target.isClosed() && !survivor.isClosed();
    codemodeTimedOut =
      result.isError === true &&
      result.output!.some(
        (block) =>
          block.type === "text" && block.text.includes("Execution timed out after 1000 ms"),
      );
    return result;
  };
  allTools = [
    codemode,
    ...createCodemodeAdapters(async () => allTools, mcp),
    {
      name: "browser",
      description: "evaluate in the real browser",
      replay: "unsafe",
      parameters: Type.Object({ script: Type.String() }),
      execute: async (args, _api, ctx) => {
        const result = await service.execute(
          "worker",
          {
            action: "evaluate",
            pageId: "page-2",
            script: (args as { script: string }).script,
            timeoutMs: 10000,
          },
          ctx.abortSignal,
        );
        return { output: [{ type: "text", text: result.text }] };
      },
    },
  ];
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test-codemode-browser", tools: allTools }));
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
  const main = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  const script =
    "() => new Promise(() => { setTimeout(() => localStorage.setItem('late', 'bad'), 3000); void fetch('/started'); })";
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("codemode", {
          code: `// @options: {"timeout_ms": 1000}\nawait tools.browser({script: ${JSON.stringify(script)}});`,
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  const submission = await main.submit({ type: "input", content: "run" }, BACKGROUND_CONTEXT);
  await entered;
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  expect(settled.status).toBe("done");
  expect(codemodeTimedOut).toBe(true);
  expect(closedWhenAbortReturned).toBe(true);
  expect(closedWhenCodemodeReturned).toBe(true);
  const remaining = await service.execute("worker", { action: "pages" });
  expect(remaining.details.pages?.map((page) => page.id)).toEqual(["page-1"]);
  // Wait past the page's delayed write, not merely past receipt of abort.
  await new Promise((resolve) => setTimeout(resolve, 3100));
  expect(
    (
      await service.execute("worker", {
        action: "evaluate",
        pageId: "page-1",
        script: "() => localStorage.getItem('late')",
      })
    ).text,
  ).toContain("Evaluation result:\nnull");
}, 20000);

it("joins host admission cleanup even when the sandbox worker has already exited", async () => {
  let releaseAdmission!: () => void;
  let enteredAdmission!: () => void;
  const entered = new Promise<void>((resolve) => (enteredAdmission = resolve));
  const admission = new Promise<void>((resolve) => (releaseAdmission = resolve));
  let cancelled = false;
  const tool = createCodemodeTool(
    async () => [
      { name: "slow", description: "slow", parameters: Type.Object({}), execute: async () => ({}) },
    ],
    new Set(),
    async () => {
      cancelled = true;
    },
  );
  const api = {
    callId: "call",
    taskId: 1,
    conversationId: 1,
    snapshot: async (doc: { definition: { kind: string } }) =>
      doc.definition.kind === "pi.tool.nested-call" ? { taskId: 2 } : undefined,
    memo: async (_key: string, value: unknown) => value,
    executeTool: async (_name: string, _args: unknown, ctx: typeof BACKGROUND_CONTEXT) => {
      enteredAdmission();
      await admission;
      ctx.abortSignal!.throwIfAborted();
      throw new Error("expected abort");
    },
  } as unknown as ToolExecutionApi;
  // Hold admission beyond the local sandbox deadline, then let cleanup discover it.
  let settled = false;
  const pending = tool
    .execute(
      { code: '// @options: {"timeout_ms": 400}\nawait tools.slow({});' },
      api,
      BACKGROUND_CONTEXT,
    )
    .finally(() => {
      settled = true;
    });
  await entered;
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(settled).toBe(false);
  releaseAdmission();
  await pending;
  expect(cancelled).toBe(true);
});

it("does not dispatch a tool when cancellation happens during legacy receipt lookup", async () => {
  const controller = new AbortController();
  let dispatches = 0;
  const tool = createCodemodeTool(
    async () => [
      {
        name: "effect",
        description: "effect",
        parameters: Type.Object({}),
        execute: async () => ({}),
      },
    ],
    new Set(),
    async () => {},
  );
  const api = {
    callId: "call",
    taskId: 1,
    conversationId: 1,
    snapshot: async (doc: { definition: { kind: string } }) => {
      if (doc.definition.kind === "batty.codemode-calls") controller.abort();
      return undefined;
    },
    memo: async (_key: string, value: unknown) => value,
    executeTool: async () => {
      dispatches++;
      throw new Error("unexpected dispatch");
    },
  } as unknown as ToolExecutionApi;
  await tool.execute(
    { code: "await tools.effect({});" },
    api,
    withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
  );
  expect(dispatches).toBe(0);
});

it("does not enter the adapter's target after cancellation during async tool resolution", async () => {
  const controller = new AbortController();
  let dispatches = 0;
  const [adapter] = createCodemodeAdapters(async () => {
    controller.abort();
    return [
      {
        name: "effect",
        description: "effect",
        replay: "safe",
        parameters: Type.Object({}),
        execute: async () => {
          dispatches++;
          return {};
        },
      },
    ];
  }, mcp);
  await expect(
    adapter!.execute(
      { name: "effect", args: {} },
      {} as ToolExecutionApi,
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    ),
  ).rejects.toThrow();
  expect(dispatches).toBe(0);
});

it.each(["deadline", "abort"])(
  "propagates sandbox %s to a real durable nested tool",
  async (mode) => {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => (started = resolve));
    let sawAbort = false;
    let lateDispatches = 0;
    let blockedDispatch = false;
    let allTools: ToolRegistration[] = [];
    let harness!: Harness;
    const codemode = createCodemodeTool(
      async () => allTools,
      new Set(),
      async (id) => {
        await harness.abortTask(id, BACKGROUND_CONTEXT);
      },
    );
    allTools = [
      codemode,
      ...createCodemodeAdapters(async () => allTools, mcp),
      {
        name: "slow",
        description: "wait for cancellation",
        replay: "safe",
        parameters: Type.Object({}),
        execute: async (_args, api, ctx) => {
          started();
          await new Promise<void>((resolve) => {
            const abort = () => {
              sawAbort = true;
              resolve();
            };
            if (ctx.abortSignal!.aborted) abort();
            else ctx.abortSignal!.addEventListener("abort", abort, { once: true });
          });
          try {
            await api.executeTool("effect", {}, BACKGROUND_CONTEXT);
          } catch {
            blockedDispatch = true;
          }
          ctx.abortSignal!.throwIfAborted();
          return {};
        },
      },
      {
        name: "effect",
        description: "must not run",
        replay: "safe",
        parameters: Type.Object({}),
        execute: async () => {
          lateDispatches++;
          return {};
        },
      },
    ];
    const registry = createRegistry();
    registry.install(defineExtension({ name: "test-codemode", tools: allTools }));
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
    const main = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: '// @options: {"timeout_ms": 500}\nawait tools.slow({}); await tools.effect({});',
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const submission = await main.submit({ type: "input", content: "run" }, BACKGROUND_CONTEXT);
    await entered;
    if (mode === "abort") await main.abort(BACKGROUND_CONTEXT);
    await submission.wait(BACKGROUND_CONTEXT);
    expect(sawAbort).toBe(true);
    expect(blockedDispatch).toBe(true);
    expect(lateDispatches).toBe(0);
  },
);
