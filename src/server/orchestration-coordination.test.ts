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

test.each(
  ["steer", "stop", "queue", "resume"].flatMap((action) =>
    ["unrelated", "coordinator", "peer"].flatMap((caller) =>
      [false, true].flatMap((callerCron) =>
        [false, true].map((targetCron) => ({ action, caller, callerCron, targetCron })),
      ),
    ),
  ),
)(
  "$action follows workspace scope for $caller (callerCron=$callerCron, targetCron=$targetCron)",
  async ({ action, caller, callerCron, targetCron }) => {
    const { faux, open, orchestration } = await fixture(
      10_000,
      console.error,
      caller === "peer" ? undefined : "test",
    );
    const { harness, main } = await open();
    faux.setResponses([
      call({
        action: "run",
        prompt: "target",
        workspaceId: caller === "coordinator" ? "other" : "test",
      }),
      done(),
      done(),
    ]);
    await (await main.submit({ type: "input", content: "start" }, context)).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    const target = Object.values((await orchestrationHistory(harness)).workers)[0]!;
    faux.setResponses([
      call({
        action: "run",
        prompt: "reader",
        workspaceId: caller === "unrelated" ? "other" : "test",
      }),
      done(),
      done(),
    ]);
    await (await main.submit({ type: "input", content: "launch reader" }, context)).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    const reader = Object.values((await orchestrationHistory(harness)).workers).find(
      (worker) => worker.id !== target.id,
    )!;
    await main.commit(async (tx) => {
      (await tx.doc(WorkerDoc, target.id)).isCron = targetCron;
      (await tx.doc(WorkerDoc, reader.id)).isCron = callerCron;
    }, context);
    faux.setResponses(
      Array.from(
        { length: 15 },
        () => (request: { messages: readonly { role: string; content: unknown }[] }) => {
          const last = request.messages.findLast((message) => message.role !== "system")!;
          if (last.role === "user" && JSON.stringify(last.content).includes("reader"))
            return call({ action, sessionId: String(target.id), prompt: "interference" });
          return done();
        },
      ),
    );
    await (
      await (await harness.conversation(reader.id, context))!.submit(
        { type: "input", content: "reader" },
        context,
      )
    ).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    const history = await orchestrationHistory(harness);
    const messages = (await (await harness.conversation(reader.id, context))!.context(context))
      .messages;
    const result = messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "subagent",
    )!;
    if (caller === "unrelated") {
      expect(result.role === "toolResult" && result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("coordination scope");
      expect(history.workers[String(target.id)]).toEqual(target);
    } else {
      expect(JSON.stringify(result.content)).not.toContain("coordination scope");
      expect(result.role === "toolResult" && !!result.isError).toBe(
        action === "steer" || action === "queue",
      );
    }
  },
);

test.each(
  ["run", "resume"].flatMap((action) =>
    [false, true].map((descendant) => ({ action, descendant })),
  ),
)(
  "project cron $action stays in its workspace (descendant=$descendant)",
  async ({ action, descendant }) => {
    const { faux, open, orchestration } = await fixture(10_000, console.error, "test");
    const { harness, main } = await open();
    faux.setResponses([
      call({ action: "run", prompt: "idle", workspaceId: "other" }),
      done(),
      done(),
    ]);
    await (await main.submit({ type: "input", content: "seed" }, context)).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    const target = Object.values((await orchestrationHistory(harness)).workers)[0]!;
    faux.setResponses(
      Array.from({ length: 30 }, () => (request) => {
        const last = request.messages.findLast((message) => message.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("project cron"))
          return descendant
            ? call({ action: "run", prompt: "project child" })
            : call({
                action,
                ...(action === "resume" ? { sessionId: String(target.id) } : {}),
                prompt: "move",
                workspaceId: "test",
              });
        if (last.role === "user" && text.includes("project child"))
          return call({
            action,
            ...(action === "resume" ? { sessionId: String(target.id) } : {}),
            prompt: "move",
            workspaceId: "test",
          });
        return done();
      }),
    );
    const job = await orchestration.addJob({
      title: "Scheduled test task",
      prompt: "project cron",
      workspaceId: "other",
      session: { kind: "daily-detached" },
      schedule: { kind: "at", in: "1h" },
    });
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    const workers = Object.values((await orchestrationHistory(harness)).workers);
    const reader = workers.find(
      (worker) => worker.prompt === (descendant ? "project child" : "project cron"),
    )!;
    const messages = (await (await harness.conversation(reader.id, context))!.context(context))
      .messages;
    const result = messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "subagent",
    )!;
    expect(result.role === "toolResult" && result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "Project workers delegate within their own workspace",
    );
    expect(workers.every((worker) => worker.workspaceId === "other")).toBe(true);
  },
);

test.each(["run", "resume"])(
  "project %s cannot move work to the coordinator workspace",
  async (action) => {
    const { faux, open, orchestration } = await fixture(10_000, console.error, "test");
    const { harness, main } = await open();
    let readerId: string | undefined;
    faux.setResponses(
      Array.from({ length: 30 }, () => (request) => {
        const last = request.messages.findLast((message) => message.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("launch"))
          return call({ action: "run", prompt: "reader", workspaceId: "other" });
        if (last.role === "user" && text.includes("reader"))
          return call({
            action,
            ...(action === "resume" ? { sessionId: readerId! } : {}),
            prompt: "cross workspace",
            workspaceId: "test",
          });
        return done();
      }),
    );
    // For resume, target an idle peer in the reader's workspace.
    if (action === "resume") {
      faux.setResponses([
        call({ action: "run", prompt: "idle", workspaceId: "other" }),
        done(),
        done(),
      ]);
      await (await main.submit({ type: "input", content: "seed" }, context)).wait(context);
      await until(async () => (await orchestration.listRunning()).length === 0);
      await main.waitForIdle(context);
      readerId = String(Object.values((await orchestrationHistory(harness)).workers)[0]!.id);
      faux.setResponses([
        call({ action: "run", prompt: "reader", workspaceId: "other" }),
        call({
          action: "resume",
          sessionId: readerId,
          prompt: "cross workspace",
          workspaceId: "test",
        }),
        done(),
        done(),
      ]);
    }
    await (await main.submit({ type: "input", content: "launch" }, context)).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    const workers = Object.values((await orchestrationHistory(harness)).workers);
    const reader = workers.find((worker) => worker.prompt === "reader")!;
    const messages = (await (await harness.conversation(reader.id, context))!.context(context))
      .messages;
    const result = messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "subagent",
    )!;
    expect(result.role === "toolResult" && result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "Project workers delegate within their own workspace",
    );
    expect(workers.every((worker) => worker.workspaceId === "other")).toBe(true);
  },
);
