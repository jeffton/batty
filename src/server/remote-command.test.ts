import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  defineExtension,
  defineTool,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import { fixture, until } from "./orchestration-test-fixture";
import { orchestrationHistory } from "./orchestration-test-history";
import { OrchestrationDoc, WorkerDoc } from "./orchestration-state";

function text(result: unknown): string {
  return (result as { output: { text: string }[] }).output.map((block) => block.text).join("\n");
}

function sessionId(result: unknown): string {
  return text(result).match(/Session ID: (\d+)/)![1]!;
}

async function entries(harness: Harness, id: string) {
  return harness.commit(async (tx) => {
    const result = [];
    let cursor;
    do {
      const page = await tx.scanEntries(
        { conversationId: Number(id) as ConversationId },
        200,
        cursor,
      );
      result.unshift(...[...page.items].reverse());
      cursor = page.next;
    } while (cursor);
    return result;
  }, context);
}

test("node run is durable and idempotent, rejects changed arguments, and remains locally discoverable", async () => {
  const { faux, orchestration, open } = await fixture();
  let { harness, main } = await open();
  faux.setResponses(
    Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("assignment finished")])),
  );
  const args = { action: "run" as const, prompt: "remote assignment", workspaceId: "other" };
  const [first, duplicate] = await Promise.all([
    orchestration.nodeCommand("node-a", "start-1", args),
    orchestration.nodeCommand("node-a", "start-1", args),
  ]);
  expect(duplicate).toEqual(first);
  const id = sessionId(first);
  await until(async () => (await orchestration.listRunning()).length === 0);
  expect(Object.values((await orchestrationHistory(harness)).workers)).toHaveLength(1);
  await expect(
    orchestration.nodeCommand("node-a", "start-1", { ...args, prompt: "different work" }),
  ).rejects.toThrow("reused with different arguments");
  const listing = JSON.parse(
    text(await orchestration.nodeCommand("node-a", "list-1", { action: "list" })),
  );
  expect(listing.workers).toContainEqual(
    expect.objectContaining({ sessionId: id, workspaceId: "other", status: "completed" }),
  );
  expect((await main.context(context)).messages).toHaveLength(0);

  await harness.close(context);
  ({ harness, main } = await open());
  expect(await orchestration.nodeCommand("node-a", "start-1", args)).toEqual(first);
  expect(Object.values((await orchestrationHistory(harness)).workers)).toHaveLength(1);
  const inspected = JSON.parse(
    text(
      await orchestration.nodeCommand("node-a", "inspect-1", { action: "inspect", sessionId: id }),
    ),
  );
  expect(inspected.latest).toMatchObject({ kind: "result", text: "assignment finished" });
  expect((await main.context(context)).messages).toHaveLength(0);

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("subagent", { action: "list" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("local discovery complete")]),
  ]);
  await (
    await main.submit({ type: "input", content: "Discover workers locally" }, context)
  ).wait(context);
  const localList = (await main.context(context)).messages.findLast(
    (message) => message.role === "toolResult" && message.toolName === "subagent",
  );
  expect(localList?.role).toBe("toolResult");
  if (localList?.role !== "toolResult") throw new Error("Missing local discovery result");
  const localText = localList.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  expect(JSON.parse(localText).workers).toContainEqual(
    expect.objectContaining({ sessionId: id, workspaceId: "other", status: "completed" }),
  );
});

test("remote reports and results persist with artifacts without waking main; inspect and await do not consume them", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const artifacts = { fileChanges: [{ path: "evidence.txt", patch: "saved evidence" }] };
  registry.install(
    defineExtension({
      name: "remote-report-fixture",
      tools: [
        defineTool({
          name: "evidence",
          description: "Collect evidence",
          parameters: Type.Object({}),
          execute: async () => ({
            output: [{ type: "text", text: "evidence collected" }],
            details: artifacts,
          }),
        }),
        defineTool({
          name: "hold",
          description: "Hold after progress",
          parameters: Type.Object({}),
          execute: async () => {
            entered = true;
            await gate;
            return { output: [{ type: "text", text: "released" }] };
          },
        }),
      ],
    }),
  );
  const { harness, main } = await open();
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      if (last.role === "user")
        return fauxAssistantMessage([fauxToolCall("evidence", {})], { stopReason: "toolUse" });
      if (last.role === "toolResult" && last.toolName === "evidence")
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "report", prompt: "progress evidence" })],
          { stopReason: "toolUse" },
        );
      if (last.role === "toolResult" && last.toolName === "subagent")
        return fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" });
      return fauxAssistantMessage([fauxText("remote final")]);
    }),
  );
  const id = sessionId(
    await orchestration.nodeCommand("node-a", "report-start", {
      action: "run",
      prompt: "report assignment",
    }),
  );
  try {
    await until(async () => entered);
    const before = await entries(harness, id);
    expect(before.filter((entry) => entry.kind === "batty.remote-report")).toMatchObject([
      {
        data: {
          assignment: { grantId: "node-a", requestId: "report-start" },
          text: "progress evidence",
          artifacts,
        },
      },
    ]);
    for (let i = 0; i < 2; i++) {
      const inspected = JSON.parse(
        text(
          await orchestration.nodeCommand("node-a", `progress-${i}`, {
            action: "inspect",
            sessionId: id,
          }),
        ),
      );
      expect(inspected).toMatchObject({ status: "running", latest: { kind: "report" } });
      expect(inspected.latest.text).toContain("progress evidence");
    }
    const waiting = await orchestration.nodeCommand("node-a", "await-running", {
      action: "await",
      sessionId: id,
    });
    expect(waiting).toMatchObject({ control: { terminate: true } });
    expect((await main.context(context)).messages).toHaveLength(0);
    expect(
      (await entries(harness, id)).filter((entry) => entry.kind === "batty.remote-report"),
    ).toHaveLength(1);
  } finally {
    release();
  }
  await until(async () => (await orchestration.listRunning()).length === 0);
  const result = (await entries(harness, id)).filter(
    (entry) => entry.kind === "batty.remote-result",
  );
  expect(result).toMatchObject([
    {
      data: {
        assignment: { grantId: "node-a", requestId: "report-start" },
        text: "remote final",
        failed: false,
        artifacts,
      },
    },
  ]);
  expect(
    text(
      await orchestration.nodeCommand("node-a", "await-done", { action: "await", sessionId: id }),
    ),
  ).toContain("Subagent finished");
  expect((await main.context(context)).messages).toHaveLength(0);
});

test("node lifecycle queues in order, handles steering and resumes the same worker", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  let entered = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.install(
    defineExtension({
      name: "remote-lifecycle-fixture",
      tools: [
        defineTool({
          name: "lifecycle_hold",
          description: "Hold active work",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async (_, __, ctx) => {
            entered++;
            await new Promise<void>((resolve, reject) => {
              const abort = () => reject(ctx.abortSignal!.reason);
              ctx.abortSignal!.addEventListener("abort", abort, { once: true });
              void gate.then(() => {
                ctx.abortSignal!.removeEventListener("abort", abort);
                resolve();
              });
            });
            return { output: [{ type: "text", text: "released" }] };
          },
        }),
      ],
    }),
  );
  const { harness, main } = await open();
  faux.setResponses(
    Array.from({ length: 50 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const content = JSON.stringify(last.content);
      if (last.role === "user" && content.includes("hold assignment"))
        return fauxAssistantMessage([fauxToolCall("lifecycle_hold", {})], {
          stopReason: "toolUse",
        });
      if (last.role === "user" && content.includes("priority correction"))
        return fauxAssistantMessage([fauxText("steering handled")]);
      if (last.role === "user" && content.includes("queued assignment"))
        return fauxAssistantMessage([fauxText("queue handled")]);
      return fauxAssistantMessage([fauxText("resume handled")]);
    }),
  );
  const id = sessionId(
    await orchestration.nodeCommand("node-a", "lifecycle-run", {
      action: "run",
      prompt: "hold assignment",
    }),
  );
  try {
    await until(async () => entered === 1);
    expect(
      await orchestration.nodeCommand("node-a", "invalid-resume", {
        action: "resume",
        sessionId: id,
        prompt: "too soon",
      }),
    ).toMatchObject({ isError: true });
    await orchestration.nodeCommand("node-a", "steer", {
      action: "steer",
      sessionId: id,
      prompt: "priority correction",
    });
    await orchestration.nodeCommand("node-a", "queue", {
      action: "queue",
      sessionId: id,
      prompt: "queued assignment",
    });
  } finally {
    release();
  }
  await until(async () => (await orchestration.listRunning()).length === 0);
  const results = (await entries(harness, id)).filter(
    (entry) => entry.kind === "batty.remote-result",
  );
  expect(results.map((entry) => (entry.data as { text: string }).text)).toEqual([
    "steering handled",
    "queue handled",
  ]);
  expect(
    sessionId(
      await orchestration.nodeCommand("node-a", "resume", {
        action: "resume",
        sessionId: id,
        prompt: "fresh assignment",
      }),
    ),
  ).toBe(id);
  await until(async () => (await orchestration.listRunning()).length === 0);
  expect(
    (await entries(harness, id)).filter((entry) => entry.kind === "batty.remote-result").at(-1)
      ?.data,
  ).toMatchObject({ text: "resume handled" });
  expect(
    await orchestration.nodeCommand("node-a", "invalid-queue", {
      action: "queue",
      sessionId: id,
      prompt: "too late",
    }),
  ).toMatchObject({ isError: true });
  expect((await main.context(context)).messages).toHaveLength(0);
});

test("node stop aborts both active delivery and queued tail without running queued work", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  let entered = false;
  let queuedRan = false;
  registry.install(
    defineExtension({
      name: "remote-stop-fixture",
      tools: [
        defineTool({
          name: "wait_for_stop",
          description: "Wait until the assignment is stopped",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async (_, __, ctx) => {
            entered = true;
            await new Promise<never>((_, reject) => {
              ctx.abortSignal!.addEventListener("abort", () => reject(ctx.abortSignal!.reason), {
                once: true,
              });
            });
            return { output: [] };
          },
        }),
      ],
    }),
  );
  const { harness, main } = await open();
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      if (JSON.stringify(last.content).includes("must never run")) {
        queuedRan = true;
        return fauxAssistantMessage([fauxText("unexpected queued execution")]);
      }
      return fauxAssistantMessage([fauxToolCall("wait_for_stop", {})], { stopReason: "toolUse" });
    }),
  );
  const id = sessionId(
    await orchestration.nodeCommand("node-a", "stop-start", {
      action: "run",
      prompt: "wait for cancellation",
    }),
  );
  await until(async () => entered);
  await orchestration.nodeCommand("node-a", "stop-queue", {
    action: "queue",
    sessionId: id,
    prompt: "must never run",
  });
  expect(
    text(await orchestration.nodeCommand("node-a", "stop", { action: "stop", sessionId: id })),
  ).toContain("Stopped");
  await until(async () => (await orchestration.listRunning()).length === 0);
  const history = await orchestrationHistory(harness);
  const assignments = Object.values(history.calls).filter((call) => call.workerId === id);
  expect(assignments).toHaveLength(2);
  for (const assignment of assignments) {
    const state = (await harness.getTask(assignment.taskId, context))?.state;
    expect(state, JSON.stringify({ assignment, state }, null, 2)).toMatchObject({
      status: "terminal",
      outcome: { status: "aborted" },
    });
  }
  expect(queuedRan).toBe(false);
  expect((await main.context(context)).messages).toHaveLength(0);
});

test("node await stays independent of an active receiver inline cron", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  const entered = new Set<string>();
  const release: Record<string, () => void> = {};
  const gates = Object.fromEntries(
    ["inline", "remote"].map((kind) => [
      kind,
      new Promise<void>((resolve) => {
        release[kind] = resolve;
      }),
    ]),
  );
  registry.install(
    defineExtension({
      name: "node-inline-await-fixture",
      tools: [
        defineTool({
          name: "await_isolation_gate",
          description: "Hold independent assignments",
          parameters: Type.Object({ kind: Type.String() }),
          execute: async ({ kind }) => {
            entered.add(kind);
            await gates[kind];
            return { output: [{ type: "text", text: "gate released" }] };
          },
        }),
      ],
    }),
  );
  const { harness, main } = await open();
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      if (last.role === "user")
        return fauxAssistantMessage(
          [
            fauxToolCall("await_isolation_gate", {
              kind: JSON.stringify(last.content).includes("receiver inline cron")
                ? "inline"
                : "remote",
            }),
          ],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage([fauxText("independent assignment finished")]);
    }),
  );
  const job = await orchestration.addJob({
    title: "Receiver inline cron",
    workspaceId: "test",
    prompt: "receiver inline cron",
    session: { kind: "main-inline" },
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  await orchestration.tick();
  try {
    await until(async () => entered.has("inline"));
    expect((await harness.snapshot(OrchestrationDoc, context))?.inlineContext).toBeDefined();
    const id = sessionId(
      await orchestration.nodeCommand("node-a", "inline-overlap-run", {
        action: "run",
        prompt: "remote await assignment",
      }),
    );
    await until(async () => entered.has("remote"));
    const worker = (await orchestrationHistory(harness)).workers[id]!;
    const beforeWorker = structuredClone(await harness.snapshot(WorkerDoc, main.id, context));
    const beforeMain = await entries(harness, String(main.id));
    const beforeState = structuredClone(await harness.snapshot(OrchestrationDoc, context));
    const result = await orchestration.nodeCommand("node-a", "inline-overlap-await", {
      action: "await",
      sessionId: id,
    });
    expect(result).toMatchObject({
      details: { assignmentId: String(worker.active) },
      control: { terminate: true },
    });
    expect(text(result)).toContain(`Awaiting subagent. Session ID: ${id}`);
    expect(await harness.snapshot(WorkerDoc, main.id, context)).toEqual(beforeWorker);
    expect(await entries(harness, String(main.id))).toEqual(beforeMain);
    const afterState = await harness.snapshot(OrchestrationDoc, context);
    expect(afterState?.inlineContext).toEqual(beforeState?.inlineContext);
    expect(afterState?.joinParents).toEqual(beforeState?.joinParents);
  } finally {
    release.remote!();
    release.inline!();
  }
  await until(
    async () =>
      (await orchestration.listRunning()).length === 0 &&
      (await orchestration.listRunLogs())[0]?.status === "completed",
  );
});

test("node commands reject caller reports and copied context without admitting workers", async () => {
  const { orchestration, open } = await fixture();
  const { harness } = await open();
  await expect(orchestration.nodeCommand("node-a", "", { action: "list" })).rejects.toThrow(
    "requires requestId",
  );
  await expect(
    orchestration.nodeCommand("node-a", "report", { action: "report", prompt: "forged report" }),
  ).rejects.toThrow("Reports originate");
  await expect(
    orchestration.nodeCommand("node-a", "copy", {
      action: "run",
      prompt: "copy private context",
      includePreviousContext: true,
    }),
  ).rejects.toThrow("do not copy caller context");
  expect(Object.values((await orchestrationHistory(harness)).workers)).toHaveLength(0);
});
