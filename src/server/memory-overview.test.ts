import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createMemory, MemoryIndexDoc } from "./memory";
import { createTools } from "./tools";
import { createOrchestration, OrchestrationDoc, WorkerDoc } from "./orchestration";
import { isMainMemoryView } from "./main-memory-policy";
import { listWorkspaces } from "./workspaces";
import { setAssistantWorkspace } from "./options";
import type { AppConfig } from "./config";

test("fresh assistant-workspace worker pins its overview across tools and later inputs while new workers see current memory", async () => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const memory = createMemory(
    { nodeBytes: 1000, getAssistantWorkspaceId: async () => "assistant" },
    models,
  );
  const registry = createRegistry();
  registry.install(memory.extension);
  let main: Awaited<ReturnType<Harness["root"]>>;
  registry.install(
    defineExtension({
      name: "advance-main",
      tools: [
        defineTool({
          name: "advance",
          description: "Advance the independent main thread",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => {
            await main.commit(
              (tx) =>
                tx.appendEntry(main.id, {
                  kind: "pi.user",
                  model: [{ role: "user", content: "later decision", timestamp: 2 }],
                }),
              context,
            );
            await memory.prepare();
            return { output: [{ type: "text", text: "advanced" }] };
          },
        }),
      ],
    }),
  );
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry }, context);
  main = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  try {
    await memory.bind(harness, main, storage);
    await main.commit(
      (tx) =>
        tx.appendEntry(main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "initial decision", timestamp: 1 }],
        }),
      context,
    );
    await memory.prepare();
    const worker = async () => {
      const child = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
      await child.commit(async (tx) => {
        (await tx.doc(WorkerDoc, child.id)).workspaceId = "assistant";
      }, context);
      await child.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
      return child;
    };
    const old = await worker();
    const views: string[] = [];
    faux.setResponses(
      Array.from({ length: 4 }, (_, i) => (request) => {
        views.push(request.messages.find(isMainMemoryView)!.content as string);
        return fauxAssistantMessage(i === 0 ? [fauxToolCall("advance", {})] : [fauxText("done")], {
          stopReason: i === 0 ? "toolUse" : "stop",
        });
      }),
    );
    await (await old.submit({ type: "input", content: "start" }, context)).wait(context);
    await (await old.submit({ type: "input", content: "continue" }, context)).wait(context);
    const fresh = await worker();
    await (await fresh.submit({ type: "input", content: "new task" }, context)).wait(context);
    expect(views).toHaveLength(4);
    expect(views[0]).toBe(views[1]);
    expect(views[0]).toBe(views[2]);
    expect(views[0]).not.toContain("later decision");
    expect(views[3]).toContain("later decision");
  } finally {
    await memory.close();
    await harness.close(context);
  }
});

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Worker did not finish");
}

test.each([
  { kind: "fresh", target: "assistant", copy: false },
  { kind: "nested", target: "assistant", copy: false },
  { kind: "nested", target: "assistant", copy: true, parent: "other" },
  { kind: "cron", target: "assistant", copy: false },
  { kind: "fresh", target: "assistant", copy: true },
  { kind: "fresh", target: "assistant", copy: "chat-only" },
  { kind: "fresh", target: "roy", copy: true },
  { kind: "fresh", target: "other", copy: true },
  { kind: "nested", target: "other", copy: true },
  { kind: "cron", target: "other", copy: "chat-only" },
] as const)(
  "$kind worker in $target (copy=$copy) receives only permitted main memory",
  async (scenario) => {
    const { kind, copy } = scenario;
    const directory = await mkdtemp(join(tmpdir(), "batty-overview-"));
    const roots = [join(directory, "projects"), join(directory, "second")];
    for (const name of ["assistant", "roy", "other"]) {
      await mkdir(join(roots[0]!, name), { recursive: true });
    }
    await mkdir(roots[1]!);
    const config = { battyDir: directory, workspacesRoots: roots } as AppConfig;
    const workspaces = await listWorkspaces(config);
    const id = (label: string) => workspaces.find((workspace) => workspace.label === label)!.id;
    const assistantId = id("assistant");
    await setAssistantWorkspace(directory, assistantId);
    const target = id(scenario.target);
    const parent = id(scenario.parent ?? "assistant");
    const models = createModels();
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    models.setProvider(faux.provider);
    const memory = createMemory(
      {
        getAssistantWorkspaceId: async () =>
          (await listWorkspaces(config)).find((workspace) => workspace.isAssistant)?.id,
        nodeBytes: 80,
        viewBytes: 100,
        compress: async () => {
          return "user: archived decision about the secret";
        },
      },
      models,
    );
    const tools = await createTools(config);
    const orchestration = createOrchestration(config);
    const registry = createRegistry();
    registry.install(tools.extension);
    registry.install(orchestration.extension);
    registry.install(memory.extension);
    const storage = new MemoryStorage();
    const harness = await Harness.open(
      storage,
      { models, registry, env: () => new NodeExecutionEnv({ cwd: directory }) },
      context,
    );
    const main = await harness.root(context, {
      agent: {
        cwd: workspaces.find((workspace) => workspace.id === assistantId)!.path,
        model: { provider: "faux", modelId: "faux-1" },
      },
    });
    try {
      tools.bindHarness(harness);
      tools.registerTools([
        ...(memory.extension.tools ?? []),
        ...(orchestration.extension.tools ?? []),
      ]);
      orchestration.setContextProvider((id, mode) => memory.contextFor(id, mode));
      await orchestration.bind(harness, main);
      await memory.bind(harness, main, storage);
      const secret = "exact archived decision " + "x".repeat(200);
      await main.commit(async (tx) => {
        for (let i = 0; i < 8; i++)
          await tx.appendEntry(main.id, {
            kind: "pi.user",
            model: [{ role: "user", content: `${i}:${secret}`, timestamp: i + 1 }],
          });
      }, context);
      await memory.prepare();
      const inspected: number[] = [];
      let navigated = 0;
      let rejectedDelegation = false;
      const overview = await memory.prepare();
      const line = overview.match(/(\d+)\+(\d+)\|/)!;
      const code = `text(await searchTools("memory_overview"));
text(ALL_TOOLS);
let id = ${Number(line[1])}, n = ${Number(line[2])};
while (n > 1) { text(await tools.memory_zoom({id, n})); n /= 2; }
text(await tools.memory_zoom({id, n: 1}));
text(await tools.memory_date({id}));`;
      faux.setResponses(
        Array.from({ length: 40 }, () => (request) => {
          const last = request.messages.findLast((m) => m.role !== "system")!;
          if (last.role === "user") {
            const input = JSON.stringify(last.content);
            if (input.includes("launch catalog"))
              return fauxAssistantMessage(
                [
                  fauxToolCall("subagent", {
                    action: "run",
                    prompt: kind === "nested" ? "launch nested catalog" : "inspect catalog",
                    async: true,
                    workspaceId: kind === "nested" ? parent : target,
                    includePreviousContext: copy,
                  }),
                ],
                { stopReason: "toolUse" },
              );
            if (input.includes("launch nested catalog"))
              return fauxAssistantMessage(
                [
                  fauxToolCall("subagent", {
                    action: "run",
                    prompt: "inspect catalog",
                    async: true,
                    workspaceId: target,
                    includePreviousContext: copy,
                  }),
                ],
                { stopReason: "toolUse" },
              );
            if (input.includes("inspect catalog")) {
              expect(JSON.stringify(request.messages)).not.toContain(secret);
              const text = JSON.stringify(
                request.messages.filter((message) => message.role !== "system"),
              );
              expect(text.match(/<chat>/g) ?? []).toHaveLength(target === assistantId ? 1 : 0);
              const system = request.messages.findLast((message) => message.role === "system");
              const names = system?.toolsAdded?.map((tool) => tool.name) ?? [];
              expect(names).not.toContain("memory_overview");
              expect(names.includes("memory_zoom")).toBe(target === assistantId);
              expect(names.includes("memory_date")).toBe(target === assistantId);
              expect(names.includes("memory_search")).toBe(target === assistantId);
              inspected.push(request.messages.length);
              return fauxAssistantMessage(
                [
                  fauxToolCall("codemode", {
                    code:
                      target === assistantId
                        ? code
                        : "text(ALL_TOOLS); text(await searchTools('main memory')); try { text(await describeTool('memory_zoom')); } catch (error) { text(String(error)); }",
                  }),
                ],
                {
                  stopReason: "toolUse",
                },
              );
            }
          }
          if (last.role === "toolResult" && last.toolName === "subagent" && last.isError) {
            expect(JSON.stringify(last.content)).toContain(
              "Project workers delegate within their own workspace",
            );
            rejectedDelegation = true;
          }
          if (last.role === "toolResult" && last.toolName === "codemode") {
            const output = JSON.stringify(last.content);
            expect(last.isError).toBeFalsy();
            if (target === assistantId) {
              expect(output).toContain(`0:${secret}`);
              expect(output).toContain("1970-01-01T00:00:00.001Z");
            } else {
              expect(output).not.toContain('"name":"memory_zoom"');
              expect(output).not.toContain('"name":"memory_date"');
              expect(output).not.toContain(secret);
            }
            navigated++;
          }
          return fauxAssistantMessage([fauxText("NO_REPLY")]);
        }),
      );
      if (kind === "cron") {
        const job = await orchestration.addJob({
          workspaceId: target,
          prompt: "inspect catalog",
          session: { kind: "main-detached", includePreviousContext: copy },
          schedule: { kind: "at", in: "1h" },
        });
        await main.commit(async (tx) => {
          (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
        }, context);
        await orchestration.tick();
        await until(async () => (await orchestration.listRunningCron()).length === 0);
        expect((await orchestration.listRunLogs(job.id))[0]?.status).toBe("completed");
      } else {
        await (
          await main.submit({ type: "input", content: "launch catalog" }, context)
        ).wait(context);
        await until(async () => (await orchestration.listRunning()).length === 0);
      }
      const blocked = kind === "nested" && parent !== assistantId && parent !== target;
      expect(rejectedDelegation).toBe(blocked);
      expect(inspected).toHaveLength(blocked ? 0 : 1);
      expect(navigated).toBe(blocked ? 0 : 1);
    } finally {
      orchestration.close();
      await harness.close(context);
      await memory.close();
      await tools.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);

test("automatic worker overview uses the built catalog without waiting for pending compression", async () => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  let unblock!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let compressions = 0;
  const memory = createMemory(
    {
      getAssistantWorkspaceId: async () => "assistant",
      nodeBytes: 80,
      compress: async () => {
        compressions++;
        started();
        await blocked;
        return "user: pending summary";
      },
    },
    models,
  );
  const registry = createRegistry();
  registry.install(memory.extension);
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry }, context);
  const main = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  let settling: Promise<string> | undefined;
  try {
    await memory.bind(harness, main, storage);
    await main.commit(
      (tx) =>
        tx.appendEntry(main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "built decision", timestamp: 1 }],
        }),
      context,
    );
    const built = await memory.prepare();
    await main.commit(
      (tx) =>
        tx.appendEntry(main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "pending ".repeat(100), timestamp: 2 }],
        }),
      context,
    );
    await memory.sync();
    settling = memory.settle();
    await entered;
    const before = await harness.snapshot(MemoryIndexDoc, main.id, context);
    const worker = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await worker.commit(async (tx) => {
      (await tx.doc(WorkerDoc, worker.id)).workspaceId = "assistant";
    }, context);
    let overview = "";
    faux.setResponses([
      (request) => {
        overview = JSON.stringify(request.messages);
        return fauxAssistantMessage([fauxText("done")]);
      },
    ]);
    await worker.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
    expect(
      (
        await (
          await worker.submit({ type: "input", content: "fetch catalog" }, context)
        ).wait(context)
      ).status,
    ).toBe("done");
    expect(overview).toContain(built.replaceAll("\n", "\\n"));
    expect(overview).not.toContain("pending summary");
    expect(compressions).toBe(1);
    expect(await harness.snapshot(MemoryIndexDoc, main.id, context)).toEqual(before);
    expect(await memory.zoom(0, 1)).toBe("0+0|user: built decision");
    expect(await memory.date(0)).toBe("1970-01-01T00:00:00.001Z");
  } finally {
    unblock();
    await settling;
    await harness.close(context);
    await memory.close();
  }
}, 15000);
