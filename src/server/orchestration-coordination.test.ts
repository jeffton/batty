import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { fixture, until } from "./orchestration-test-fixture";
import { orchestrationHistory } from "./orchestration-test-history";
import { OrchestrationDoc, WorkerDoc } from "./orchestration-state";

const call = (args: Record<string, JsonValue>) =>
  fauxAssistantMessage([fauxToolCall("subagent", args)], { stopReason: "toolUse" });
const done = () => fauxAssistantMessage([fauxText("done")]);

test("run cannot reuse a session and lifecycle actions cannot create one implicitly", async () => {
  const { faux, open, orchestration } = await fixture(10_000);
  const { harness, main } = await open();
  const probe = async (args: Record<string, JsonValue>) => {
    faux.setResponses([call(args), done(), done()]);
    await (await main.submit({ type: "input", content: "probe" }, context)).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    return (await main.context(context)).messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "subagent",
    )!;
  };
  await probe({ action: "run", prompt: "first" });
  const before = await orchestrationHistory(harness);
  const sessionId = String(Object.values(before.workers)[0]!.id);
  const invalidRun = await probe({ action: "run", sessionId, prompt: "must not replace" });
  expect(invalidRun.role === "toolResult" && invalidRun.isError).toBe(true);
  expect(JSON.stringify(invalidRun.content)).toContain("run creates a new subagent");
  for (const action of ["await", "queue", "resume", "steer", "stop"]) {
    const result = await probe({ action, prompt: "must not create" });
    expect(result.role === "toolResult" && result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(`${action} requires sessionId`);
  }
  expect(await orchestrationHistory(harness)).toEqual(before);
});

test.each(["steer", "stop", "queue", "resume"])(
  "%s can manage a worker in another workspace",
  async (action) => {
    const { faux, open, orchestration } = await fixture(10_000, console.error, "other");
    const { harness, main } = await open();
    faux.setResponses([
      call({ action: "run", prompt: "target", workspaceId: "other" }),
      done(),
      done(),
    ]);
    await (await main.submit({ type: "input", content: "start target" }, context)).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    const target = Object.values((await orchestrationHistory(harness)).workers)[0]!;
    faux.setResponses([
      call({ action: "run", prompt: "reader", workspaceId: "test" }),
      done(),
      done(),
    ]);
    await (await main.submit({ type: "input", content: "start reader" }, context)).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    const reader = Object.values((await orchestrationHistory(harness)).workers).find(
      (worker) => worker.id !== target.id,
    )!;
    await main.commit(async (tx) => {
      (await tx.doc(WorkerDoc, target.id)).isCron = true;
      (await tx.doc(WorkerDoc, reader.id)).isCron = true;
    }, context);
    faux.setResponses(
      Array.from({ length: 15 }, () => (request) => {
        const last = request.messages.findLast((message) => message.role !== "system")!;
        if (last.role === "user" && JSON.stringify(last.content).includes("manage target"))
          return call({ action, sessionId: String(target.id), prompt: "cross-workspace update" });
        return done();
      }),
    );
    const conversation = (await harness.conversation(reader.id, context))!;
    await (
      await conversation.submit({ type: "input", content: "manage target" }, context)
    ).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    const result = (await conversation.context(context)).messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "subagent",
    )!;
    expect(JSON.stringify(result.content)).not.toContain("coordination scope");
    expect(result.role === "toolResult" && !!result.isError).toBe(
      action === "steer" || action === "queue",
    );
  },
);

test.each(["run", "resume"])("project cron can %s across workspaces", async (action) => {
  const { faux, open, orchestration } = await fixture(10_000, console.error, "test");
  const { harness, main } = await open();
  const idleTarget = action === "resume";
  if (idleTarget) {
    faux.setResponses([
      call({ action: "run", prompt: "idle target", workspaceId: "test" }),
      done(),
      done(),
    ]);
    await (await main.submit({ type: "input", content: "seed target" }, context)).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
  }
  const existingTarget = idleTarget
    ? String(Object.values((await orchestrationHistory(harness)).workers)[0]!.id)
    : undefined;
  faux.setResponses(
    Array.from({ length: 40 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("scheduled project task"))
        return call({
          action,
          ...(action === "resume" ? { sessionId: existingTarget! } : {}),
          prompt: "cross-workspace scheduled work",
          workspaceId: "test",
        });
      return done();
    }),
  );
  const job = await orchestration.addJob({
    title: "Scheduled test task",
    prompt: "scheduled project task",
    workspaceId: "other",
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  await orchestration.tick();
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  const workers = Object.values((await orchestrationHistory(harness)).workers);
  const cron = workers.find((worker) => worker.prompt === "scheduled project task")!;
  const result = (
    await (await harness.conversation(cron.id, context))!.context(context)
  ).messages.findLast(
    (message) => message.role === "toolResult" && message.toolName === "subagent",
  )!;
  expect(result.role === "toolResult" && !!result.isError).toBe(false);
  if (action === "run") {
    expect(workers.some((worker) => worker.prompt === "cross-workspace scheduled work")).toBe(true);
    expect(
      workers.find((worker) => worker.prompt === "cross-workspace scheduled work")!.workspaceId,
    ).toBe("test");
  } else {
    expect(workers.find((worker) => String(worker.id) === existingTarget)!.workspaceId).toBe(
      "test",
    );
  }
});

test("await remains limited to direct children", async () => {
  const { faux, open, orchestration } = await fixture(10_000);
  const { harness, main } = await open();
  faux.setResponses([
    call({ action: "run", prompt: "first reader", workspaceId: "other" }),
    done(),
    done(),
  ]);
  await (await main.submit({ type: "input", content: "launch first" }, context)).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  faux.setResponses([
    call({ action: "run", prompt: "second reader", workspaceId: "test" }),
    done(),
    done(),
  ]);
  await (await main.submit({ type: "input", content: "launch second" }, context)).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  const workers = Object.values((await orchestrationHistory(harness)).workers);
  const worker = workers.find((candidate) => candidate.prompt === "first reader")!;
  const unrelated = workers.find((candidate) => candidate.prompt === "second reader")!;
  faux.setResponses([call({ action: "await", sessionId: String(unrelated.id) }), done()]);
  const conversation = (await harness.conversation(worker.id, context))!;
  await (
    await conversation.submit({ type: "input", content: "attempt invalid await" }, context)
  ).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  const messages = (await conversation.context(context)).messages;
  const result = messages.findLast(
    (message) => message.role === "toolResult" && message.toolName === "subagent",
  )!;
  expect(result.role === "toolResult" && result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("Await requires a child of this session");
});
