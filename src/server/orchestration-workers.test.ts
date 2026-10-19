import { expect, test, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, LiveDoc } from "@earendil-works/pi-durable";

import { Type } from "@earendil-works/pi-ai";

import { orchestrationHistory } from "./orchestration-test-history";

import { fixture, until } from "./orchestration-test-fixture.js";

test("worker stop availability covers preparation before its first model turn", async () => {
  const { faux, orchestration, open } = await fixture();
  const { harness, main } = await open();
  let release!: () => void;
  const prepare = new Promise<{}>((resolve) => {
    release = () => resolve({});
  });
  orchestration.setPrepareAgent(async () => prepare);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("subagent", { action: "run", prompt: "prepared worker" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("accepted")]),
    fauxAssistantMessage([fauxText("finished")]),
    fauxAssistantMessage([fauxText("received")]),
  ]);
  try {
    await (await main.submit({ type: "input", content: "launch" }, context)).wait(context);
    const [worker] = await orchestration.listRunning();
    expect(worker).toBeDefined();
    expect((await harness.snapshot(LiveDoc, worker!.conversationId, context))?.run).toBeUndefined();
    expect(await orchestration.canStopWorker(worker!.sessionId)).toBe(true);
    release();
    await until(async () => !(await orchestration.canStopWorker(worker!.sessionId)));
  } finally {
    release();
  }
});

test("stopping an already completed worker closes its retained browser; resume admission is serialized", async () => {
  const { faux, orchestration, open } = await fixture();
  const { harness, main } = await open();
  const stop = vi.fn(async () => {});
  const admit = vi.fn();
  orchestration.setWorkerBrowserLifecycle({
    admit: async (id, operation) => {
      admit(id);
      return operation();
    },
    stop,
  });
  let workerId = "";
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
      if (last.role === "user" && text.includes("launch idle browser"))
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "run",
              prompt: "finish browser worker",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("stop idle browser"))
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "stop",
              sessionId: workerId,
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("resume idle browser"))
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "resume",
              sessionId: workerId,
              prompt: "finish resumed browser",
            }),
          ],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage([fauxText("finished")]);
    }),
  );
  harness.resume();
  await (
    await main.submit({ type: "input", content: "launch idle browser" }, context)
  ).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  const history = await orchestrationHistory(harness);
  workerId = Object.keys(history.workers)[0]!;
  const taskId = String(history.workers[workerId]!.active);
  await (await main.submit({ type: "input", content: "stop idle browser" }, context)).wait(context);
  expect(stop).toHaveBeenCalledWith(workerId, taskId);
  await (
    await main.submit({ type: "input", content: "resume idle browser" }, context)
  ).wait(context);
  expect(admit).toHaveBeenCalledWith(workerId);
  await until(async () => (await orchestration.listRunning()).length === 0);
});

test("queue admits the current report before delivering the queued prompt", async () => {
  const { faux, orchestration, open } = await fixture(1000);
  const { harness, main } = await open();
  let workerId = "";
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      const last = request.messages.findLast((m) => m.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "toolResult") return fauxAssistantMessage([fauxText("accepted")]);
      if (text.includes("start queue test"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "run", prompt: "first worker prompt" })],
          { stopReason: "toolUse" },
        );
      if (text.includes("queue next"))
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "queue",
              sessionId: workerId,
              prompt: "second worker prompt",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (text.includes("first worker prompt"))
        return fauxAssistantMessage([fauxText("first ".repeat(1000))]);
      if (text.includes("second worker prompt"))
        return fauxAssistantMessage([fauxText("second result")]);
      return fauxAssistantMessage([fauxText("noted")]);
    }),
  );
  await (await main.submit({ type: "input", content: "start queue test" }, context)).wait(context);
  const initial = Object.values((await orchestrationHistory(harness))!.workers)[0]!;
  workerId = String(initial.id);
  const firstTask = initial.active!;
  await (await main.submit({ type: "input", content: "queue next" }, context)).wait(context);
  const secondTask = (await orchestrationHistory(harness))!.workers[workerId]!.active!;
  expect(secondTask).not.toBe(firstTask);
  await until(async () => (await orchestration.listRunning()).length === 0);
  const admissions = await main.commit(
    async (tx) => ({
      report: await tx.submissionByRequest(main.id, `batty-report:${firstTask}`),
      queued: await tx.submissionByRequest(initial.id, `batty-deliver:${secondTask}`),
    }),
    context,
  );
  expect(admissions.report!.id).toBeLessThan(admissions.queued!.id);
}, 15000);

test("concurrent queues chain transactionally and defer worker configuration", async () => {
  const { faux, orchestration, open, registry, directory } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: string[] = [];
  registry.install(
    defineExtension({
      name: "queue-probe",
      tools: [
        defineTool({
          name: "probe",
          description: "probe",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async (_, api) => {
            seen.push(api.env!.cwd);
            if (seen.length === 1) await gate;
            return { output: [{ type: "text", text: `probe-${seen.length}` }] };
          },
        }),
      ],
    }),
  );
  const { harness, main } = await open();
  let workerId = "";
  faux.setResponses(
    Array.from({ length: 30 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("launch probe"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "run", prompt: "first probe" })],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("queue pair"))
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "queue",
              sessionId: workerId,
              prompt: "queued-one",
              workspaceId: "other",
              effort: "high",
            }),
            fauxToolCall("subagent", {
              action: "queue",
              sessionId: workerId,
              prompt: "queued-two",
              workspaceId: "other",
              effort: "low",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (
        (last.role === "user" && text.includes("first probe")) ||
        (last.role === "toolResult" && last.toolName === "probe" && text.includes("probe-1"))
      )
        return fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" });
      return fauxAssistantMessage([fauxText("done")]);
    }),
  );
  await (await main.submit({ type: "input", content: "launch probe" }, context)).wait(context);
  const original = Object.values((await orchestrationHistory(harness))!.workers)[0]!;
  workerId = String(original.id);
  const firstTask = original.active!;
  try {
    await until(async () => seen.length === 1);
    await (await main.submit({ type: "input", content: "queue pair" }, context)).wait(context);
    const state = (await orchestrationHistory(harness))!;
    const queued = Object.values(state.calls)
      .filter((call) => call.taskId !== firstTask)
      .map((call) => call.taskId)
      .sort((a, b) => a - b);
    expect(queued).toHaveLength(2);
    expect((await harness.getTask(queued[0]!, context))!.input).toMatchObject({
      previous: firstTask,
    });
    expect((await harness.getTask(queued[1]!, context))!.input).toMatchObject({
      previous: queued[0],
    });
    expect((await (await harness.conversation(original.id, context))!.agent(context)).cwd).toBe(
      directory,
    );
  } finally {
    release();
  }
  await until(async () => (await orchestration.listRunning()).length === 0);
  expect(seen).toEqual([directory, directory]);
  const agent = await (await harness.conversation(original.id, context))!.agent(context);
  expect(agent.cwd).toBe("/tmp");
  expect(agent.thinkingLevel).toBe("low");
}, 15000);

test("concurrent resumes admit only one new worker turn", async () => {
  const { faux, orchestration, open } = await fixture(200);
  const { harness, main } = await open();
  let workerId = "";
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("initial launch"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "run", prompt: "initial worker" })],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("resume pair"))
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "resume",
              sessionId: workerId,
              prompt: "resumed-one",
            }),
            fauxToolCall("subagent", {
              action: "resume",
              sessionId: workerId,
              prompt: "resumed-two",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && (text.includes("resumed-one") || text.includes("resumed-two")))
        return fauxAssistantMessage([fauxText("working ".repeat(500))]);
      return fauxAssistantMessage([fauxText("done")]);
    }),
  );
  await (await main.submit({ type: "input", content: "initial launch" }, context)).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  workerId = Object.keys((await orchestrationHistory(harness))!.workers)[0]!;
  await (await main.submit({ type: "input", content: "resume pair" }, context)).wait(context);
  expect(Object.keys((await orchestrationHistory(harness))!.calls)).toHaveLength(2);
  const failures = (await main.context(context)).messages.filter(
    (message) => message.role === "toolResult" && message.isError,
  );
  expect(failures).toHaveLength(1);
  expect(JSON.stringify(failures)).toContain("Subagent is running");
}, 15000);

test.each(["tool", "host"])(
  "subagent %s stop cancels the active delivery and its queued tail",
  async (source) => {
    const { faux, orchestration, open } = await fixture(300);
    const { harness, main } = await open();
    let workerId = "";
    faux.setResponses(
      Array.from({ length: 20 }, () => (request) => {
        const last = request.messages.findLast((message) => message.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("launch stoppable"))
          return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "run", prompt: "long worker task" })],
            { stopReason: "toolUse" },
          );
        if (last.role === "user" && text.includes("queue stoppable"))
          return fauxAssistantMessage(
            [
              fauxToolCall("subagent", {
                action: "queue",
                sessionId: workerId,
                prompt: "queued worker must never start",
              }),
            ],
            { stopReason: "toolUse" },
          );
        if (last.role === "user" && text.includes("stop worker"))
          return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "stop", sessionId: workerId })],
            { stopReason: "toolUse" },
          );
        if (last.role === "user" && text.includes("long worker task"))
          return fauxAssistantMessage([fauxText("working ".repeat(1000))]);
        return fauxAssistantMessage([fauxText("done")]);
      }),
    );
    await (
      await main.submit({ type: "input", content: "launch stoppable" }, context)
    ).wait(context);
    workerId = Object.keys((await orchestrationHistory(harness))!.workers)[0]!;
    await (await main.submit({ type: "input", content: "queue stoppable" }, context)).wait(context);
    if (source === "tool")
      await (await main.submit({ type: "input", content: "stop worker" }, context)).wait(context);
    else await orchestration.stopWorker(workerId);
    await until(async () => (await orchestration.listRunning()).length === 0);
    const worker = (await harness.conversation(Number(workerId) as never, context))!;
    expect(JSON.stringify((await worker.context(context)).messages)).not.toContain(
      "queued worker must never start",
    );
    for (const call of Object.values((await orchestrationHistory(harness))!.calls)) {
      const task = await harness.waitForTask(call.taskId, context);
      expect(task.state.outcome.status).toBe("aborted");
    }
  },
  15000,
);

test("closing in-flight background work resumes the same child input and report", async () => {
  const { faux, orchestration, open } = await fixture(100);
  let { harness, main } = await open();
  faux.setResponses(
    Array.from({ length: 10 }, () => (request) => {
      const last = request.messages.findLast((m) => m.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (text.includes("start slow"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "run", prompt: "slow child" })],
          { stopReason: "toolUse" },
        );
      if (text.includes("slow child"))
        return fauxAssistantMessage([fauxText("working ".repeat(300))]);
      return fauxAssistantMessage([fauxText("accepted")]);
    }),
  );
  await main.submit({ type: "input", content: "start slow" }, context);
  await until(async () => Object.keys((await orchestrationHistory(harness))!.workers).length === 1);
  const worker = Object.values((await orchestrationHistory(harness))!.workers)[0]!;
  await until(async () =>
    JSON.stringify(
      (await (await harness.conversation(worker.id, context))!.context(context)).messages,
    ).includes("slow child"),
  );
  await harness.close(context);
  faux.setResponses(
    Array.from({ length: 10 }, () => (request) => {
      const last = request.messages.findLast((m) => m.role !== "system")!;
      return fauxAssistantMessage([
        fauxText(JSON.stringify(last.content).includes("slow child") ? "recovered child" : "noted"),
      ]);
    }),
  );
  ({ harness, main } = await open());
  harness.resume();
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  const child = (await harness.conversation(worker.id, context))!;
  expect(
    (await child.context(context)).messages.filter(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("slow child"),
    ),
  ).toHaveLength(1);
  expect(
    (await main.context(context)).messages.filter(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("recovered child"),
    ),
  ).toHaveLength(1);
}, 15000);
