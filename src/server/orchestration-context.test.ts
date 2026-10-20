import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

import { Type, getCurrentTools } from "@earendil-works/pi-ai";

import { orchestrationHistory } from "./orchestration-test-history";

import { fixture, until } from "./orchestration-test-fixture.js";

test("fresh workers receive only their task, not the parent transcript", async () => {
  const { faux, orchestration, open } = await fixture();
  const { harness, main } = await open();
  await main.configure(
    { instructions: "explicit parent instructions", thinkingLevel: "medium" },
    context,
  );
  await main.commit(async (tx) => {
    await tx.appendEntry(main.id, {
      kind: "pi.user",
      model: [{ role: "user", content: "archive-only", timestamp: 1 }],
    });
  }, context);
  faux.setResponses(
    Array.from({ length: 10 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      if (last.role === "user" && JSON.stringify(last.content).includes("launch"))
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "run",
              prompt: "worker task",
            }),
          ],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage([fauxText("done")]);
    }),
  );
  await (await main.submit({ type: "input", content: "launch" }, context)).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  const worker = Object.values((await orchestrationHistory(harness))!.workers)[0]!;
  const child = (await harness.conversation(worker.id, context))!;
  const view = await child.viewState(context);
  expect(view.value.conversation.parent).toBeUndefined();
  const copied = JSON.stringify(view.value.entries);
  expect(copied).not.toContain("archive-only");
  expect(copied).not.toContain("launch");
  expect(copied).toContain("worker task");
  expect(await child.agent(context)).toMatchObject({
    instructions: "explicit parent instructions",
    thinkingLevel: "medium",
    model: { provider: "faux", modelId: "faux-1" },
  });
  view.dispose();
}, 15000);

test("worker agent preparation applies workspace-scoped tools before generation admission", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  const scoped = defineTool({
    name: "worker_scope",
    description: "scope",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_, api) => ({ output: [{ type: "text", text: `scoped:${api.env!.cwd}` }] }),
  });
  const scopedExtension = defineExtension({ name: "worker-mcp-scope", tools: [scoped] });
  registry.install(scopedExtension);
  const { harness, main } = await open();
  await main.configure({ extensions: [orchestration.extension] }, context);
  const prepared: { cwd: string; actualCwd: string | undefined }[] = [];
  orchestration.setPrepareAgent(async (cwd, agent) => {
    prepared.push({ cwd, actualCwd: agent.cwd });
    return { extensions: [...agent.extensions, scopedExtension], tools: [scoped] };
  });
  faux.setResponses(
    Array.from({ length: 12 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("launch scoped worker"))
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "run",
              workspaceId: "other",
              prompt: "use worker scoped tool",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("use worker scoped tool")) {
        expect(getCurrentTools(request.messages).map((tool) => tool.name)).toEqual([
          "worker_scope",
        ]);
        return fauxAssistantMessage([fauxToolCall("worker_scope", {})], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage([fauxText("done")]);
    }),
  );
  await (
    await main.submit({ type: "input", content: "launch scoped worker" }, context)
  ).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  expect(prepared).toEqual([{ cwd: "/tmp", actualCwd: "/tmp" }]);
  const worker = Object.values((await orchestrationHistory(harness))!.workers)[0]!;
  const messages = (await (await harness.conversation(worker.id, context))!.context(context))
    .messages;
  const result = messages.find(
    (message) => message.role === "toolResult" && message.toolName === "worker_scope",
  );
  expect(JSON.stringify(result)).toContain("scoped:/tmp");
  expect(result?.role === "toolResult" && result.isError).toBe(false);
  expect((await main.agent(context)).tools.map((tool) => tool.name)).toEqual(["subagent", "cron"]);
}, 15000);

test("NO_REPLY subagent results still reach their parent", async () => {
  const { faux, orchestration, open } = await fixture();
  const { main } = await open();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("subagent", { action: "run", prompt: "silent helper" })], {
      stopReason: "toolUse",
    }),
    ...Array.from(
      { length: 5 },
      () => (request: { messages: readonly import("@earendil-works/pi-ai").Message[] }) => {
        const last = request.messages.findLast((message) => message.role !== "system")!;
        if (last.role === "user" && JSON.stringify(last.content).includes("silent helper"))
          return fauxAssistantMessage([fauxText("NO_REPLY")]);
        return fauxAssistantMessage([fauxText("parent finished")]);
      },
    ),
  ]);
  await (await main.submit({ type: "input", content: "launch" }, context)).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  const reports = (await main.context(context)).messages.filter(
    (message) => message.role === "user" && JSON.stringify(message.content).includes("NO_REPLY"),
  );
  expect(reports).toHaveLength(1);
  expect(JSON.stringify(reports[0])).toContain("subagent");
});

test("workers spawned by a worker deliver async replies only to their parent", async () => {
  const { faux, orchestration, open } = await fixture();
  const { harness, main } = await open();
  const call = (prompt: string) =>
    fauxAssistantMessage([fauxToolCall("subagent", { action: "run", prompt })], {
      stopReason: "toolUse",
    });
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      const last = request.messages.findLast((m) => m.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "toolResult") return fauxAssistantMessage([fauxText("accepted")]);
      if (text.includes("start outer")) return call("start inner");
      if (text.includes("start inner")) return call("leaf task");
      if (text.includes("leaf task")) return fauxAssistantMessage([fauxText("leaf answer")]);
      return fauxAssistantMessage([fauxText("noted")]);
    }),
  );
  await (await main.submit({ type: "input", content: "start outer" }, context)).wait(context);
  await until(async () => Object.keys((await orchestrationHistory(harness))!.workers).length === 2);
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  const state = (await orchestrationHistory(harness))!;
  expect(Object.values(state.workers).some((w) => w.parentId !== main.id)).toBe(true);
  const mainHistory = JSON.stringify((await main.context(context)).messages);
  expect(mainHistory).not.toContain("leaf answer");
  const outer = Object.values(state.workers).find((w) => w.parentId === main.id)!;
  const outerHistory = JSON.stringify(
    (await (await harness.conversation(outer.id, context))!.context(context)).messages,
  );
  expect(outerHistory).toContain("leaf answer");
}, 15000);

test("main run/resume returns immediately and idle results start a turn", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.install(
    defineExtension({
      name: "main-async-test",
      tools: [
        defineTool({
          name: "hold_worker",
          description: "hold worker",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => {
            await gate;
            return { output: [{ type: "text", text: "released" }] };
          },
        }),
      ],
    }),
  );
  const { harness, main } = await open();
  let workerId: string | undefined;
  faux.setResponses(
    Array.from({ length: 40 }, () => (request) => {
      const last = request.messages.findLast((m) => m.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (
        last.role === "user" &&
        (text.includes("launch async test") || text.includes("resume async test"))
      )
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: text.includes("resume async test") ? "resume" : "run",
              ...(workerId ? { sessionId: workerId } : {}),
              prompt: "held implementation",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("held implementation"))
        return fauxAssistantMessage([fauxToolCall("hold_worker", {})], { stopReason: "toolUse" });
      if (last.role === "toolResult" && last.toolName === "hold_worker")
        return fauxAssistantMessage([fauxText("held worker final")]);
      return fauxAssistantMessage([fauxText("main available")]);
    }),
  );
  try {
    await (
      await main.submit({ type: "input", content: "launch async test" }, context)
    ).wait(context);
    const state = (await orchestrationHistory(harness))!;
    workerId = String(Object.values(state.workers)[0]!.id);
    const running = await orchestration.listRunning();
    expect(running).toHaveLength(1);
    expect(running[0]!.startedAtMs).toBeGreaterThan(Date.now() - 60000);
    expect(running[0]!.startedAtMs).toBeLessThanOrEqual(Date.now());
    expect(running[0]!.startedAtMs).toBe(state.workers[workerId]!.startedAtMs);
    const result = (await main.context(context)).messages.find(
      (m) => m.role === "toolResult" && m.toolName === "subagent",
    );
    expect(result).toMatchObject({
      details: { subagent: { respondIn: "session" } },
    });
  } finally {
    release();
  }
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  let history = (await main.context(context)).messages;
  expect(
    history.some(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("held worker final"),
    ),
  ).toBe(true);
  expect(history.at(-1)).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "main available" }],
  });
  await (await main.submit({ type: "input", content: "resume async test" }, context)).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  history = (await main.context(context)).messages;
  const starts = history.filter((m) => m.role === "toolResult" && m.toolName === "subagent");
  expect(starts).toHaveLength(2);
  for (const start of starts)
    expect(start).toMatchObject({
      content: [{ type: "text", text: `Started. Session ID: ${workerId}` }],
      details: { subagent: { respondIn: "session" } },
    });
}, 15000);

test("async reports steer a busy main before its final reply", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  let releaseMain!: () => void;
  let releaseWorker!: () => void;
  let mainHeld = false;
  const mainGate = new Promise<void>((resolve) => {
    releaseMain = resolve;
  });
  const workerGate = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });
  registry.install(
    defineExtension({
      name: "report-steer-test",
      tools: [
        defineTool({
          name: "hold",
          description: "hold",
          parameters: Type.Object({ main: Type.Boolean() }),
          replay: "safe",
          execute: async (args) => {
            if (args.main) {
              mainHeld = true;
              await mainGate;
            } else await workerGate;
            return { output: [{ type: "text", text: "released" }] };
          },
        }),
      ],
    }),
  );
  const { harness, main } = await open();
  let reacted = false;
  faux.setResponses(
    Array.from({ length: 30 }, () => (request) => {
      const last = request.messages.findLast((m) => m.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("launch steering test"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "run", prompt: "steering worker" })],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("steering worker"))
        return fauxAssistantMessage([fauxToolCall("hold", { main: false })], {
          stopReason: "toolUse",
        });
      if (last.role === "toolResult" && last.toolName === "subagent")
        return fauxAssistantMessage([fauxToolCall("hold", { main: true })], {
          stopReason: "toolUse",
        });
      if (last.role === "user" && text.includes("worker steering result")) {
        reacted = true;
        return fauxAssistantMessage([fauxText("main reacted before final")]);
      }
      if (last.role === "toolResult" && last.toolName === "hold") {
        const wasMain = request.messages.some(
          (m) => m.role === "user" && JSON.stringify(m.content).includes("launch steering test"),
        );
        return fauxAssistantMessage([
          fauxText(wasMain ? "main missed steering" : "worker steering result"),
        ]);
      }
      return fauxAssistantMessage([fauxText("noted")]);
    }),
  );
  const submission = await main.submit({ type: "input", content: "launch steering test" }, context);
  try {
    await until(async () => mainHeld);
    releaseWorker();
    await until(async () => (await orchestration.listRunning()).length === 0);
  } finally {
    releaseWorker();
    releaseMain();
  }
  await submission.wait(context);
  await main.waitForIdle(context);
  expect(reacted).toBe(true);
  const history = (await main.context(context)).messages;
  expect(JSON.stringify(history)).not.toContain("main missed steering");
  expect(history.findLast((m) => m.role === "assistant")).toMatchObject({
    content: [{ type: "text", text: "main reacted before final" }],
  });
  expect(Object.values((await orchestrationHistory(harness))!.workers)).toHaveLength(1);
}, 15000);
