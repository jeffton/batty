import { expect, test, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  defineExtension,
  defineTool,
  defineTask,
  LiveDoc,
  type SubmissionId,
  type TaskId,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { fixture, until } from "./orchestration-test-fixture.js";
import { OrchestrationDoc, WorkerDoc } from "./orchestration-state.js";
import type { createDeliveryTask } from "./orchestration-delivery.js";
import type { createWorkers } from "./orchestration-workers.js";

const sessionId = (result: unknown) => /Session ID: (\d+)/.exec(JSON.stringify(result))![1]!;

test("preparation failure reports its error to the parent without admitting a worker prompt", async () => {
  const { faux, orchestration, open } = await fixture();
  const { harness, main } = await open();
  orchestration.setPrepareAgent(async () => {
    throw new Error("workspace preparation unavailable");
  });
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      if (last.role === "user" && JSON.stringify(last.content).includes("launch local worker"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "run", prompt: "unadmitted assignment" })],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage([fauxText("noted")]);
    }),
  );
  await (
    await main.submit({ type: "input", content: "launch local worker" }, context)
  ).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  expect(JSON.stringify((await main.context(context)).messages)).toContain(
    "failed during delivery: Error: workspace preparation unavailable",
  );
  const history = JSON.parse(
    (await orchestration.queryWorkers({ action: "list", status: "all" })).output[0]!.text,
  );
  const worker = history.workers[0]!;
  expect(worker.status).toBe("failed");
  const task = await harness.getTask(Number(worker.assignmentId) as never, context);
  expect(task?.state.status === "terminal" && task.state.outcome.result).toContain(
    "workspace preparation unavailable",
  );
  expect(
    await main.commit(
      (tx) =>
        tx.submissionByRequest(
          Number(worker.sessionId) as never,
          `batty-deliver:${worker.assignmentId}`,
        ),
      context,
    ),
  ).toBeUndefined();
});

test.each(["return", "throw"])(
  "stop during preparation wins when the preparer finishes by %s",
  async (finish) => {
    const { faux, orchestration, open } = await fixture();
    const { harness, main } = await open();
    let preparing = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    orchestration.setPrepareAgent(async () => {
      preparing = true;
      await gate;
      if (finish === "throw") throw new Error("preparation interrupted");
      return {};
    });
    let modelCalls = 0;
    faux.setResponses([
      () => {
        modelCalls++;
        return fauxAssistantMessage([fauxText("must not execute")]);
      },
    ]);
    try {
      const id = sessionId(
        await orchestration.nodeCommand("audit", "stop-preparing-start", {
          action: "run",
          prompt: "must not be admitted",
        }),
      );
      await until(async () => preparing);
      const taskId = (await harness.snapshot(OrchestrationDoc, context))!.workers[id]!.active!;
      const stopped = orchestration.stopWorker(id);
      await until(async () => (await harness.getTask(taskId, context))!.abortRequested);
      release();
      await stopped;
      const task = await harness.waitForTask(taskId, context);
      expect(task.state.outcome.status).toBe("aborted");
      expect(modelCalls).toBe(0);
      expect(
        await main.commit(
          (tx) => tx.submissionByRequest(Number(id) as never, `batty-deliver:${taskId}`),
          context,
        ),
      ).toBeUndefined();
      expect(
        (await harness.snapshot(WorkerDoc, Number(id) as never, context))?.completion,
      ).toBeUndefined();
    } finally {
      release();
    }
  },
);

test.each(["running", "completed", "stop"])(
  "assignment retirement fences old continuations with a %s generation",
  async (priorRun) => {
    const { faux, orchestration, open, registry } = await fixture(1000);
    let releaseStopPhase!: () => void;
    const stopPhaseGate = new Promise<void>((resolve) => {
      releaseStopPhase = resolve;
    });
    let releaseJoined!: () => void;
    const joinedGate = new Promise<void>((resolve) => {
      releaseJoined = resolve;
    });
    const Target = defineTask<null, { phase: "wait" }, string>({
      name: "joined-fault-target",
      version: 1,
      initial: () => ({ phase: "wait" }),
      phases: {
        wait: async (_, runtime, ctx) => {
          await joinedGate;
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: "stale joined continuation" },
            }),
            ctx,
          );
        },
      },
      abort: async (_, runtime, ctx) => {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
      },
    });
    let joinedTarget: TaskId<string> | undefined;
    let waiter: TaskId<null> | undefined;
    let blocked = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.install(
      defineExtension({
        name: "fault-resume-probe",
        tasks: [Target],
        tools: [
          defineTool({
            name: "block_resumed_assignment",
            description: "Keep the resumed assignment open for steering",
            parameters: Type.Object({}),
            execute: async () => {
              blocked = true;
              await gate;
              return { output: [{ type: "text", text: "released" }] };
            },
          }),
        ],
      }),
    );
    const { harness, main } = await open();
    await main.configure(
      {
        extensions: [registry.snapshot().extension("fault-resume-probe")!, orchestration.extension],
      },
      context,
    );
    let staleInputExecuted = false;
    faux.setResponses(
      Array.from({ length: 30 }, () => (request) => {
        const last = request.messages.findLast((message) => message.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("stale queued input")) staleInputExecuted = true;
        if (last.role === "user" && text.includes("resumed assignment"))
          return fauxAssistantMessage([fauxToolCall("block_resumed_assignment", {})], {
            stopReason: "toolUse",
          });
        return fauxAssistantMessage([
          fauxText(priorRun !== "completed" ? "working ".repeat(1000) : "done"),
        ]);
      }),
    );
    const delivery = orchestration.extension.tasks!.find(
      (task) => task.definition.name === "batty.delivery",
    ) as ReturnType<typeof createDeliveryTask>;
    const AwaitChild = orchestration.extension.tasks!.find(
      (task) => task.definition.name === "batty.await-child",
    ) as ReturnType<typeof createWorkers>["AwaitChild"];
    // Seed the same joined/queued inputs for legacy fault recovery and ordinary stop.
    const fault = vi
      .spyOn(delivery.definition.phases, "deliver")
      .mockImplementationOnce(async (task, runtime, ctx) => {
        const child = (await runtime.conversation(task.input.childId, ctx))!;
        let original: SubmissionId | undefined;
        await runtime.commit(async (tx) => {
          const submission = await child.submit(tx, {
            type: "input",
            content: "original assignment",
            whenBusy: "followUp",
            requestId: `batty-deliver:${task.id}`,
          });
          (await tx.doc(WorkerDoc, task.input.childId)).completion = {
            owner: task.id,
            inputs: [submission],
            waits: {},
          };
          original = submission;
          if (priorRun !== "completed") {
            joinedTarget = await tx.createTask(Target, null, {
              ownership: { kind: "conversation" },
              background: true,
            });
            waiter = await tx.createTask(
              AwaitChild,
              { target: joinedTarget, workerId: "joined-target", parentId: task.input.childId },
              { ownership: { kind: "task", taskId: task.id } },
            );
            (await tx.doc(WorkerDoc, task.input.childId)).completion!.waits[String(joinedTarget)] =
              waiter;
          }
        }, ctx);
        if (priorRun === "completed") await (await harness.submission(original!, ctx))!.wait(ctx);
        else
          await child.submit(
            { type: "input", content: "stale queued input", whenBusy: "followUp" },
            ctx,
          );
        if (priorRun === "stop") {
          await stopPhaseGate;
          await runtime.commit(
            () => ({ status: "running", checkpoint: { phase: "deliver" } }),
            ctx,
          );
          return;
        }
        throw new Error("persisted delivery fault from earlier version");
      });
    try {
      const id = sessionId(
        await orchestration.nodeCommand("audit", `fault-start-${priorRun}`, {
          action: "run",
          prompt: "original assignment",
        }),
      );
      const oldTask = (await harness.snapshot(OrchestrationDoc, context))!.workers[id]!.active!;
      if (priorRun === "stop") await until(async () => waiter !== undefined);
      else {
        await until(
          async () => (await harness.getTask(oldTask, context))!.state.status === "terminal",
        );
        const old = await harness.waitForTask(oldTask, context);
        expect(old.state.outcome.status).toBe("faulted");
      }
      expect(
        (await harness.snapshot(WorkerDoc, Number(id) as never, context))?.completion?.owner,
      ).toBe(oldTask);
      const oldGeneration = (await harness.snapshot(LiveDoc, Number(id) as never, context))?.run
        ?.taskId;
      if (priorRun !== "completed") expect(oldGeneration).toBeDefined();
      fault.mockRestore();
      const abortTask = harness.abortTask.bind(harness);
      let lateWaiter: TaskId<null> | undefined;
      const releasing = vi.spyOn(harness, "abortTask").mockImplementation(async (...args) => {
        if (args[0] === waiter && joinedTarget && lateWaiter === undefined) {
          await main.commit(async (tx) => {
            const completion = (await tx.doc(WorkerDoc, Number(id) as never)).completion!;
            expect(completion.retiring).toBe(true);
            // Simulate a legacy/in-flight watcher missed by the retirement snapshot.
            lateWaiter = await tx.createTask(
              AwaitChild,
              { target: joinedTarget!, workerId: "late-target", parentId: Number(id) as never },
              { ownership: { kind: "conversation" }, background: true },
            );
            completion.waits[String(joinedTarget)] = lateWaiter;
          }, context);
          const rejected = await orchestration.nodeCommand("audit", "retiring-steer", {
            action: "steer",
            sessionId: id,
            prompt: "must not start during retirement",
          });
          expect(rejected.isError).toBe(true);
        }
        const result = await abortTask(...args);
        if (args[0] === oldGeneration) releaseJoined();
        return result;
      });
      if (priorRun === "stop") {
        const stopping = orchestration.stopWorker(id);
        await until(async () => (await harness.getTask(oldTask, context))!.abortRequested);
        releaseStopPhase();
        await stopping;
        await until(
          async () => (await harness.getTask(oldTask, context))!.state.status === "terminal",
        );
      } else {
        await orchestration.nodeCommand("audit", `fault-resume-${priorRun}`, {
          action: "resume",
          sessionId: id,
          prompt: "resumed assignment",
        });
        await until(async () => blocked);
      }
      releasing.mockRestore();
      if (waiter)
        expect((await harness.waitForTask(waiter, context)).state.outcome.status).toBe("aborted");
      if (joinedTarget)
        expect((await harness.waitForTask(joinedTarget, context)).state.outcome.status).toBe(
          "completed",
        );
      if (lateWaiter)
        expect((await harness.waitForTask(lateWaiter, context)).state.outcome.status).toBe(
          "completed",
        );
      if (priorRun === "stop") {
        expect((await harness.waitForTask(oldTask, context)).state.outcome.status).toBe("aborted");
        expect(
          (await harness.snapshot(WorkerDoc, Number(id) as never, context))?.completion,
        ).toBeUndefined();
        expect(
          (await harness.snapshot(LiveDoc, Number(id) as never, context))?.run,
        ).toBeUndefined();
        expect(staleInputExecuted).toBe(false);
        expect(
          JSON.stringify(
            (await (await harness.conversation(Number(id) as never, context))!.context(context))
              .messages,
          ),
        ).not.toContain("stale joined continuation");
        return;
      }
      const newTask = (await harness.snapshot(OrchestrationDoc, context))!.workers[id]!.active!;
      expect(newTask).not.toBe(oldTask);
      expect(
        (await harness.snapshot(WorkerDoc, Number(id) as never, context))?.completion?.owner,
      ).toBe(newTask);
      if (oldGeneration)
        expect((await harness.waitForTask(oldGeneration, context)).state.outcome.status).toBe(
          "aborted",
        );
      const steered = await orchestration.nodeCommand("audit", `fault-steer-${priorRun}`, {
        action: "steer",
        sessionId: id,
        prompt: "valid steering after fault recovery",
      });
      expect(steered.isError).not.toBe(true);
      expect(staleInputExecuted).toBe(false);
      expect(
        JSON.stringify(
          (await (await harness.conversation(Number(id) as never, context))!.context(context))
            .messages,
        ),
      ).not.toContain("stale joined continuation");
      release();
      await orchestration.stopWorker(id);
    } finally {
      fault.mockRestore();
      releaseJoined();
      releaseStopPhase();
      release();
    }
  },
  15000,
);

test.each(["running", "artifact"])(
  "delivery lookup failure preserves %s work in its parent failure report",
  async (scenario) => {
    const { faux, orchestration, open, registry } = await fixture(1000);
    const artifacts = {
      sites: [
        { id: "partial-fault-site", name: "Partial result", url: "https://example.com/partial" },
      ],
    };
    registry.install(
      defineExtension({
        name: "partial-fault-artifact",
        tools: [
          defineTool({
            name: "partial_fault_result",
            description: "Produce a partial result",
            parameters: Type.Object({}),
            execute: async () => ({ output: [fauxText("attached")], details: artifacts }),
          }),
        ],
      }),
    );
    const { harness, main } = await open();
    await main.configure(
      {
        extensions: [
          registry.snapshot().extension("partial-fault-artifact")!,
          orchestration.extension,
        ],
      },
      context,
    );
    faux.setResponses(
      Array.from({ length: 20 }, () => (request) => {
        const last = request.messages.findLast((message) => message.role !== "system")!;
        if (last.role === "user" && JSON.stringify(last.content).includes("launch lookup failure"))
          return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "run", prompt: "orphan lookup assignment" })],
            { stopReason: "toolUse" },
          );
        if (
          last.role === "user" &&
          JSON.stringify(last.content).includes("orphan lookup assignment")
        )
          return scenario === "artifact"
            ? fauxAssistantMessage([fauxToolCall("partial_fault_result", {})], {
                stopReason: "toolUse",
              })
            : fauxAssistantMessage([fauxText("working ".repeat(1000))]);
        return fauxAssistantMessage([fauxText("noted")]);
      }),
    );
    const submission = harness.submission.bind(harness);
    let injected = false;
    const fault = vi.spyOn(harness, "submission").mockImplementation(async (...args) => {
      const original = await submission(...args);
      if (!original || injected) return original;
      injected = true;
      return new Proxy(original, {
        get(target, property, receiver) {
          if (property !== "wait") return Reflect.get(target, property, receiver);
          return async () => {
            if (scenario === "artifact") await original.wait(context);
            throw new Error("injected result lookup failure");
          };
        },
      });
    });
    try {
      await (
        await main.submit({ type: "input", content: "launch lookup failure" }, context)
      ).wait(context);
      await until(async () => (await orchestration.listRunning()).length === 0);
      await main.waitForIdle(context);
      expect(injected).toBe(true);
      const messages = JSON.stringify((await main.context(context)).messages);
      expect(messages).toContain("failed during delivery: Error: injected result lookup failure");
      expect(messages).toContain("orchestration-delivery-fault.test.ts:");
      const history = JSON.parse(
        (await orchestration.queryWorkers({ action: "list", status: "all" })).output[0]!.text,
      );
      const worker = history.workers[0]!;
      expect(worker.status).toBe("failed");
      if (scenario === "artifact") {
        const inspected = await orchestration.queryWorkers({
          action: "inspect",
          sessionId: worker.sessionId,
        });
        expect("details" in inspected && inspected.details).toMatchObject(artifacts);
        expect(messages).toContain("partial-fault-site");
      }
      expect(
        (await harness.snapshot(WorkerDoc, Number(worker.sessionId) as never, context))?.completion,
      ).toBeUndefined();
      expect(
        (await harness.snapshot(LiveDoc, Number(worker.sessionId) as never, context))?.run,
      ).toBeUndefined();
    } finally {
      fault.mockRestore();
    }
  },
);
