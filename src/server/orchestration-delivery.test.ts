import { expect, test, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, InboxDoc } from "@earendil-works/pi-durable";

import { Type } from "@earendil-works/pi-ai";

import { OrchestrationDoc } from "./orchestration.js";

import { decodeRuntimeNotice } from "./runtime-notices.js";
import { registerPushCompletions } from "./push-completions.js";
import { entryMessages, type Runtime } from "./runtime.js";
import type { WebPushService } from "./web-push.js";

import { suppressAgentCompletionNotification } from "../shared/agent-notification.js";

import { cleanup, fixture, until } from "./orchestration-test-fixture.js";

// A detached cron's final report is a normal main turn, not an inline assignment.
test.each(["daily-detached", "main-detached"] as const)(
  "main can await a worker started from a completed %s report",
  async (kind) => {
    const { faux, orchestration, open, registry } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.install(
      defineExtension({
        name: "cron-report-await",
        tools: [
          defineTool({
            name: "hold_report_worker",
            description: "Keep the worker running until main has awaited it",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async () => {
              await gate;
              return { output: [{ type: "text", text: "worker released" }] };
            },
          }),
        ],
      }),
    );
    const { harness, main } = await open();
    await main.configure({ cwd: "/tmp" }, context);
    const call = (args: Record<string, string>) =>
      fauxAssistantMessage([fauxToolCall("subagent", args)], { stopReason: "toolUse" });
    faux.setResponses(
      Array.from({ length: 20 }, () => (request) => {
        const last = request.messages.findLast((message) => message.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("scheduled report source"))
          return fauxAssistantMessage([fauxText("cron finished")]);
        if (last.role === "user" && text.includes("cron finished"))
          return call({ action: "run", prompt: "blocked report helper" });
        if (last.role === "user" && text.includes("blocked report helper"))
          return fauxAssistantMessage([fauxToolCall("hold_report_worker", {})], {
            stopReason: "toolUse",
          });
        if (last.role === "toolResult" && text.includes("Started. Session ID:"))
          return call({ action: "await", sessionId: text.match(/Session ID: (\d+)/)![1]! });
        return fauxAssistantMessage([fauxText("report work completed")]);
      }),
    );
    const job = await orchestration.addJob({
      workspaceId: "test",
      prompt: "scheduled report source",
      session: { kind },
      schedule: { kind: "at", in: "1h" },
    });
    try {
      await main.commit(async (tx) => {
        (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
      }, context);
      await orchestration.tick();
      await until(async () =>
        (await main.context(context)).messages.some(
          (message) =>
            message.role === "toolResult" &&
            message.toolName === "subagent" &&
            !JSON.stringify(message.content).includes("Started. Session ID:"),
        ),
      );
      const messages = (await main.context(context)).messages;
      const awaited = messages.findLast(
        (message) => message.role === "toolResult" && message.toolName === "subagent",
      )!;
      expect(awaited).toMatchObject({ isError: false });
      expect(JSON.stringify(awaited.content)).toContain("Awaiting subagent. Session ID:");
      expect((await harness.snapshot(OrchestrationDoc, context))!.inlineContext).toBeUndefined();
      expect((await orchestration.listRunLogs(job.id))[0]!.status).toBe("completed");
      expect((await main.agent(context)).cwd).toBe("/tmp");
    } finally {
      release();
    }
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
  },
);

test.each(
  (["new", "daily-detached", "main-detached", "daily-inline", "main-inline"] as const).flatMap(
    (kind) =>
      (
        ["NO_REPLY", " \nNO_REPLY\t", "normal result", "NO_REPLY with details", "error"] as const
      ).map((output) => ({ kind, output })),
  ),
)(
  "cron $kind with $output preserves history and only delivers non-silent results",
  async ({ kind, output }) => {
    const { faux, orchestration, open } = await fixture();
    const { harness, main } = await open();
    await main.configure({ cwd: "/tmp" }, context);
    const delivered: unknown[] = [];
    const reportError = vi.fn();
    const stop = registerPushCompletions(
      { harness, main, state: async () => ({ sessionId: String(main.id) }) } as unknown as Runtime,
      {
        notifyAgentCompleted: async (state) => {
          if (!suppressAgentCompletionNotification(state)) delivered.push(state);
        },
      } as WebPushService,
      reportError,
    );
    cleanup.push(async () => stop());
    faux.setResponses([
      () => {
        if (output === "error") throw new Error("cron provider failure NO_REPLY");
        return fauxAssistantMessage([fauxText(output)]);
      },
      fauxAssistantMessage([fauxText("report received")]),
    ]);
    const job = await orchestration.addJob({
      workspaceId: "test",
      prompt: "scheduled task",
      session: { kind },
      schedule: { kind: "at", in: "1h" },
    });
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    const before = (await main.context(context)).entries.length;
    await orchestration.tick();
    await until(async () => (await orchestration.listRunningCron()).length === 0);
    await main.waitForIdle(context);
    const run = (await orchestration.listRunLogs(job.id))[0]!;
    expect(run.status).toBe(output === "error" ? "failed" : "completed");
    expect(run.finishedAt).toBeDefined();
    expect((await orchestration.listJobs()).some((item) => item.id === job.id)).toBe(
      output === "error",
    );
    expect(run.job?.prompt).toBe("scheduled task");
    expect((await harness.getTask(run.taskId, context))!.state.outcome?.status).toBe("completed");
    if (output === "error") expect(run.output).toBe(`Task ${run.sessionId} failed: model_error`);
    else expect(run.output).toBe(output);
    const inline = kind.endsWith("inline");
    const silent = output.trim() === "NO_REPLY";
    const entries = (await main.context(context)).entries.slice(before);
    const reports = entries.filter((entry) =>
      entry.model?.some((message) => {
        if (message.role !== "user") return false;
        const notice = decodeRuntimeNotice(message.content);
        return notice?.text.includes(" result]");
      }),
    );
    expect(reports).toHaveLength(!inline && !silent ? 1 : 0);
    if (!inline && silent) expect(entries).toHaveLength(0);
    const child = (await harness.conversation(Number(run.sessionId) as never, context))!;
    if (output !== "error")
      expect((await child.context(context)).messages).toContainEqual(
        expect.objectContaining({ role: "assistant", content: [fauxText(output)] }),
      );
    expect((await main.agent(context)).cwd).toBe("/tmp");
    // Drain the serialized push observer before asserting the silent cases.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (silent) expect(delivered).toHaveLength(0);
    else if (output !== "error" || !inline) expect(delivered).toHaveLength(1);
    expect(reportError).not.toHaveBeenCalled();
  },
);

test("silent detached cron creates no report or steering while main is busy", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.install(
    defineExtension({
      name: "busy-main",
      tools: [
        defineTool({
          name: "hold",
          description: "hold main busy",
          parameters: Type.Object({}),
          replay: "safe",
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
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText(" \nNO_REPLY\t")]),
    fauxAssistantMessage([fauxText("main completed")]),
  ]);
  const submission = await main.submit({ type: "input", content: "hold main" }, context);
  await until(async () => entered);
  const before = (await main.context(context)).entries.length;
  const job = await orchestration.addJob({
    prompt: "silent scheduled task",
    session: { kind: "main-detached" },
    schedule: { kind: "at", in: "1h" },
  });
  try {
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    await until(async () => (await orchestration.listRunLogs(job.id))[0]?.status === "completed");
    const run = (await orchestration.listRunLogs(job.id))[0]!;
    expect((await main.context(context)).entries).toHaveLength(before);
    expect(
      await harness.commit(
        (tx) => tx.submissionByRequest(main.id, `batty-report:${run.taskId}`),
        context,
      ),
    ).toBeUndefined();
  } finally {
    release();
  }
  await submission.wait(context);
  await main.waitForIdle(context);
  expect(
    JSON.stringify(
      (await main.context(context)).messages.filter((message) => message.role !== "system"),
    ),
  ).not.toContain("NO_REPLY");
});

test.each(
  (
    [
      ["main-detached", false],
      ["main-detached", true],
      ["daily-detached", false],
      ["daily-detached", true],
    ] as const
  ).flatMap(([kind, busy]) =>
    (["assistant", "direct"] as const).map((delivery) => [kind, busy, delivery] as const),
  ),
)("cron %s final (main busy=%s, delivery=%s)", async (kind, busy, delivery) => {
  const { faux, orchestration, open, registry } = await fixture();
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.install(
    defineExtension({
      name: "cron-queue-test",
      tools: [
        defineTool({
          name: "hold",
          description: "hold main",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => {
            entered = true;
            await gate;
            return { output: [{ type: "text", text: "released" }] };
          },
        }),
      ],
    }),
  );
  const { main } = await open();
  let mainRequests = 0;
  faux.setResponses(
    Array.from({ length: 10 }, () => (request) => {
      if (
        request.messages.some(
          (message) => message.role === "user" && message.content === "hold main",
        )
      ) {
        mainRequests++;
        if (mainRequests === 2) {
          expect(
            request.messages.findLast((message) => message.role === "toolResult"),
          ).toMatchObject({ content: [fauxText("released")] });
          expect(JSON.stringify(request.messages)).not.toContain("missing_result");
        }
      }
      const last = request.messages.findLast((message) => message.role !== "system")!;
      if (last.role === "user" && JSON.stringify(last.content).includes("hold main"))
        return fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" });
      if (last.role === "user" && JSON.stringify(last.content).includes("scheduled work"))
        return fauxAssistantMessage([fauxText("cron final")]);
      return fauxAssistantMessage([
        fauxText(last.role === "toolResult" ? "main finished first" : "cron acknowledged"),
      ]);
    }),
  );
  const submission = busy
    ? await main.submit({ type: "input", content: "hold main" }, context)
    : undefined;
  if (busy) await until(async () => entered);
  const job = await orchestration.addJob({
    prompt: "scheduled work",
    delivery,
    session: { kind },
    schedule: { kind: "at", in: "1h" },
  });
  try {
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    await until(async () => (await orchestration.listRunLogs(job.id))[0]?.status === "completed");
    if (busy) {
      await main.commit(async (tx) => {
        const inbox = await tx.doc(InboxDoc, main.id);
        expect(inbox.items).toHaveLength(delivery === "direct" ? 0 : 1);
        if (delivery === "direct") return;
        expect(inbox.items[0]!.mode).toBe("followUp");
        const item = inbox.items[0]!;
        if (item.mode === "write") throw new Error("Expected a queued input");
        expect(decodeRuntimeNotice(item.content)?.kind).toBe("cron");
      }, context);
      if (delivery !== "direct")
        expect(JSON.stringify((await main.context(context)).messages)).not.toContain("cron final");
    }
  } finally {
    release();
  }
  await submission?.wait(context);
  await main.waitForIdle(context);
  const messages = (await main.context(context)).messages;
  const reports = messages.filter(
    (message) =>
      message.role === "user" &&
      decodeRuntimeNotice(message.content)?.kind === "cron" &&
      !decodeRuntimeNotice(message.content)?.data?.directDelivery,
  );
  expect(reports).toHaveLength(delivery === "direct" ? 0 : 1);
  const replies = messages.filter((message) => message.role === "assistant");
  if (delivery === "direct") {
    expect(mainRequests).toBe(busy ? 2 : 0);
    expect(
      entryMessages((await main.context(context)).entries).some(
        (message) =>
          message.role === "assistant" &&
          JSON.stringify(message.blocks) === JSON.stringify([fauxText("cron final")]),
      ),
    ).toBe(true);
    return;
  }
  expect(replies.at(-1)).toMatchObject({ content: [fauxText("cron acknowledged")] });
  if (busy) expect(replies.at(-2)).toMatchObject({ content: [fauxText("main finished first")] });
});

test.each(["new", "daily-inline", "main-inline"] as const)(
  "direct cron %s displays unchanged output without a main generation",
  async (kind) => {
    const { faux, orchestration, open } = await fixture();
    const { main } = await open();
    faux.setResponses([
      (request) => {
        const prompt = JSON.stringify(request.messages);
        expect(prompt).toContain("You run in a separate execution scope");
        expect(prompt).not.toContain("You run inline in the permanent main conversation");
        return fauxAssistantMessage([fauxText("full briefing\nunchanged")]);
      },
    ]);
    const job = await orchestration.addJob({
      prompt: "brief",
      delivery: "direct",
      session: { kind },
      schedule: { kind: "at", in: "1h" },
    });
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    await until(async () => (await orchestration.listRunLogs(job.id))[0]?.status === "completed");
    await main.waitForIdle(context);
    expect(entryMessages((await main.context(context)).entries)).toMatchObject([
      { role: "assistant", blocks: [fauxText("full briefing\nunchanged")] },
    ]);
    expect((await orchestration.listRunLogs(job.id))[0]!.sessionId).not.toBe(String(main.id));
  },
);

test.each(["NO_REPLY", "error"])("direct cron handles %s", async (output) => {
  const { faux, orchestration, open } = await fixture();
  const { main } = await open();
  faux.setResponses([
    () => {
      if (output === "error") throw new Error("provider failed");
      return fauxAssistantMessage([fauxText(output)]);
    },
    fauxAssistantMessage([fauxText("failure handled")]),
  ]);
  const job = await orchestration.addJob({
    prompt: "brief",
    delivery: "direct",
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  await orchestration.tick();
  await until(async () => (await orchestration.listRunningCron()).length === 0);
  await main.waitForIdle(context);
  const messages = (await main.context(context)).messages.filter(
    (message) => message.role !== "system",
  );
  if (output === "NO_REPLY") expect(messages).toEqual([]);
  else {
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [fauxText("failure handled")],
    });
    expect((await orchestration.listRunLogs(job.id))[0]!.status).toBe("failed");
  }
});
