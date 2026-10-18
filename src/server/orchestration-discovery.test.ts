import type { JsonValue } from "@earendil-works/chord";
import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { artifactRefs, createAttachArtifactsTool } from "./artifact-forwarding";
import { fixture, until } from "./orchestration-test-fixture";
import { orchestrationHistory } from "./orchestration-test-history";
import { OrchestrationDoc, WorkerDoc } from "./orchestration-state";

const call = (args: Record<string, JsonValue>) =>
  fauxAssistantMessage([fauxToolCall("subagent", args)], { stopReason: "toolUse" });
const done = () => fauxAssistantMessage([fauxText("ack")]);
const artifacts = {
  sites: [
    {
      kind: "browser" as const,
      id: "browser-artifact",
      browserId: "live-session",
      name: "Browser",
      url: "/browser",
      public: false as const,
    },
  ],
};

test("discovery paginates, inspects running reports and archived results, and forwards original artifacts", async () => {
  const { faux, registry, orchestration, open } = await fixture(1_000_000);
  let release!: () => void;
  let waiting = false;
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.install(
    defineExtension({
      name: "discovery-fixture",
      tools: [
        createAttachArtifactsTool(),
        defineTool({
          name: "pause-discovery",
          description: "Pause worker",
          parameters: Type.Object({}),
          execute: async () => {
            waiting = true;
            await gate;
            return {
              output: [{ type: "text", text: "private tool transcript must not be inspected" }],
            };
          },
        }),
        defineTool({
          name: "attach-discovery",
          description: "Attach browser",
          parameters: Type.Object({}),
          execute: async () => ({
            output: [{ type: "text", text: "attached" }],
            details: artifacts,
          }),
        }),
      ],
    }),
  );
  const { harness, main } = await open();
  faux.setResponses(
    Array.from({ length: 60 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("probe:"))
        return call(JSON.parse((last.content as string).slice(6)));
      if (last.role === "user" && text.includes("start discovery"))
        return call({ action: "run", prompt: "worker discovery", workspaceId: "test" });
      if (last.role === "user" && text.includes("report again"))
        return call({ action: "report", prompt: "new explicit progress" });
      if (last.role === "user" && text.includes("continue discovery"))
        return fauxAssistantMessage([fauxToolCall("pause-discovery", {})], {
          stopReason: "toolUse",
        });
      if (last.role === "user" && text.includes("worker discovery"))
        return fauxAssistantMessage([fauxToolCall("attach-discovery", {})], {
          stopReason: "toolUse",
        });
      if (last.role === "toolResult" && last.toolName === "attach-discovery")
        return call({ action: "report", prompt: "explicit progress" });
      if (last.role === "toolResult" && text.includes("Reported to parent"))
        return fauxAssistantMessage([fauxToolCall("pause-discovery", {})], {
          stopReason: "toolUse",
        });
      if (last.role === "toolResult" && last.toolName === "pause-discovery")
        return fauxAssistantMessage([fauxText("explicit final" + "x".repeat(17_000))]);
      return done();
    }),
  );
  const probe = async (args: Record<string, JsonValue>) => {
    await (
      await main.submit({ type: "input", content: `probe:${JSON.stringify(args)}` }, context)
    ).wait(context);
    const messages = (await main.context(context)).messages;
    const result = messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "subagent",
    )!;
    if (result.role !== "toolResult") throw new Error("Missing result");
    return result;
  };
  try {
    await (await main.submit({ type: "input", content: "start discovery" }, context)).wait(context);
    await until(async () => waiting);
    const worker = Object.values((await orchestrationHistory(harness)).workers)[0]!;
    let cursor: string | undefined;
    const discovered = [];
    do {
      const result = await probe({ action: "list", limit: 1, ...(cursor ? { cursor } : {}) });
      const page = JSON.parse((result.content[0] as { text: string }).text);
      discovered.push(...page.workers);
      cursor = page.nextCursor;
    } while (cursor);
    expect(discovered).toEqual([
      expect.objectContaining({
        sessionId: String(worker.id),
        workspaceId: "test",
        status: "running",
      }),
    ]);
    const beforeInspect = await harness.snapshot(OrchestrationDoc, context);
    const beforeWorker = await harness.snapshot(WorkerDoc, worker.id, context);
    const running = await probe({ action: "inspect", sessionId: String(worker.id) });
    expect(await harness.snapshot(OrchestrationDoc, context)).toEqual(beforeInspect);
    expect(await harness.snapshot(WorkerDoc, worker.id, context)).toEqual(beforeWorker);
    expect(JSON.stringify(running.content)).toContain("explicit progress");
    expect(running.details).toEqual(artifacts);
    expect(JSON.stringify(running.content)).not.toContain("private tool transcript");
    // A hidden cron session is not discoverable even by main.
    await main.commit(async (tx) => {
      (await tx.doc(WorkerDoc, worker.id)).isCron = true;
    }, context);
    expect((await probe({ action: "inspect", sessionId: String(worker.id) })).isError).toBe(true);
    await main.commit(async (tx) => {
      (await tx.doc(WorkerDoc, worker.id)).isCron = false;
    }, context);
    expect((await probe({ action: "inspect", sessionId: "999999999" })).isError).toBe(true);
    release();
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    const completed = await probe({ action: "inspect", sessionId: String(worker.id) });
    const body = JSON.parse((completed.content[0] as { text: string }).text);
    expect(body.status).toBe("completed");
    expect(body.latest.kind).toBe("result");
    expect(body.latest.text).toContain("explicit final");
    expect(body.latest.truncated).toBe(true);
    expect(body.latest.text).not.toContain("private tool transcript");
    expect(completed.details).toEqual(artifacts);
    waiting = false;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await probe({ action: "resume", sessionId: String(worker.id), prompt: "continue discovery" });
    await until(async () => waiting);
    const resumed = await probe({ action: "inspect", sessionId: String(worker.id) });
    const resumedBody = JSON.parse((resumed.content[0] as { text: string }).text);
    expect(resumedBody.status).toBe("running");
    expect(resumedBody.latest.kind).toBe("result");
    expect(resumedBody.latest.assignmentId).toBe(body.latest.assignmentId);
    release();
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    waiting = false;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await probe({ action: "resume", sessionId: String(worker.id), prompt: "report again" });
    await until(async () => waiting);
    const newer = await probe({ action: "inspect", sessionId: String(worker.id) });
    const newerBody = JSON.parse((newer.content[0] as { text: string }).text);
    expect(newerBody.latest.kind).toBe("report");
    expect(newerBody.latest.text).toContain("new explicit progress");
    expect(Number(newerBody.latest.assignmentId)).toBeGreaterThan(Number(body.latest.assignmentId));
    release();
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    waiting = false;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await probe({
      action: "resume",
      sessionId: String(worker.id),
      prompt: "continue discovery",
      workspaceId: "other",
    });
    await until(async () => waiting);
    const moved = await probe({ action: "inspect", sessionId: String(worker.id) });
    const movedBody = JSON.parse((moved.content[0] as { text: string }).text);
    expect(movedBody.workspaceId).toBe("other");
    expect(movedBody.latest).toBeUndefined();
    expect(moved.details).toEqual({});
    release();
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("attach_artifacts", {
            refs: artifactRefs(artifacts).map((item) => item.ref),
          }),
        ],
        { stopReason: "toolUse" },
      ),
      done(),
    ]);
    await (
      await main.submit({ type: "input", content: "forward inspected artifact" }, context)
    ).wait(context);
    const forwarded = (await main.context(context)).messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "attach_artifacts",
    );
    expect(forwarded?.role === "toolResult" && forwarded.details).toMatchObject({
      forwardedArtifacts: artifacts,
    });
  } finally {
    release();
  }
}, 15_000);

test.each([
  { workspaceId: "test", assistantWorkspaceId: undefined, visible: true },
  { workspaceId: "other", assistantWorkspaceId: undefined, visible: false },
  { workspaceId: "other", assistantWorkspaceId: "other", visible: true },
  { workspaceId: "other", assistantWorkspaceId: "test", visible: false },
])(
  "worker discovery uses the reader workspace: %j",
  async ({ workspaceId, assistantWorkspaceId, visible }) => {
    const { faux, open, orchestration } = await fixture(
      10_000,
      console.error,
      assistantWorkspaceId,
    );
    const { harness, main } = await open();
    faux.setResponses([
      call({ action: "run", prompt: "first", workspaceId: "test" }),
      done(),
      done(),
    ]);
    await (await main.submit({ type: "input", content: "start" }, context)).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    const first = Object.values((await orchestrationHistory(harness)).workers)[0]!;
    // Spawn through the tool in main, not a separate hidden session.
    faux.setResponses([
      call({ action: "run", prompt: "second", workspaceId }),
      ...Array.from(
        { length: 20 },
        () => (request: { messages: readonly { role: string; content: unknown }[] }) => {
          const last = request.messages.findLast((message) => message.role !== "system")!;
          if (last.role === "user" && JSON.stringify(last.content).includes("second"))
            return call({ action: "list", limit: 100 });
          if (last.role === "toolResult" && JSON.stringify(last.content).includes("workers"))
            return call({ action: "inspect", sessionId: String(first.id) });
          return done();
        },
      ),
    ]);
    await (await main.submit({ type: "input", content: "launch second" }, context)).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    const second = Object.values((await orchestrationHistory(harness)).workers).find(
      (worker) => worker.id !== first.id,
    )!;
    const messages = (await (await harness.conversation(second.id, context))!.context(context))
      .messages;
    const results = messages.filter(
      (message) => message.role === "toolResult" && message.toolName === "subagent",
    );
    expect(results).toHaveLength(2);
    const list = JSON.parse((results[0]!.content[0] as { text: string }).text);
    expect(
      list.workers.some((worker: { sessionId: string }) => worker.sessionId === String(first.id)),
    ).toBe(visible);
    expect(results[1]!.role === "toolResult" && !!results[1]!.isError).toBe(!visible);
  },
);

test("nested readers gain and lose cross-workspace discovery on resume", async () => {
  const { faux, orchestration, open } = await fixture(10_000, console.error, "other");
  const { harness, main } = await open();
  let targetId: string;
  faux.setResponses(
    Array.from({ length: 100 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("probe:"))
        return call(JSON.parse((last.content as string).slice(6)));
      if (last.role === "user" && text.includes("parent assignment"))
        return call({ action: "run", prompt: "reader assignment", workspaceId: "test" });
      if (last.role === "user" && text.includes("reader assignment"))
        return call({ action: "list", limit: 100 });
      if (last.role === "toolResult" && text.includes("workers"))
        return call({ action: "inspect", sessionId: targetId });
      return done();
    }),
  );
  const probe = async (args: Record<string, JsonValue>) => {
    await (
      await main.submit({ type: "input", content: `probe:${JSON.stringify(args)}` }, context)
    ).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
  };
  await probe({ action: "run", prompt: "target assignment", workspaceId: "other" });
  targetId = String(Object.values((await orchestrationHistory(harness)).workers)[0]!.id);
  await probe({ action: "run", prompt: "parent assignment", workspaceId: "other" });
  const reader = Object.values((await orchestrationHistory(harness)).workers).find(
    (worker) => worker.prompt === "reader assignment",
  )!;
  // Being spawned by an assistant-workspace parent does not grant its child access.
  const check = async (visible: boolean) => {
    const messages = (await (await harness.conversation(reader.id, context))!.context(context))
      .messages;
    const results = messages
      .filter((message) => message.role === "toolResult" && message.toolName === "subagent")
      .slice(-2);
    expect(results).toHaveLength(2);
    const listed = JSON.parse((results[0]!.content[0] as { text: string }).text).workers;
    expect(listed.some((worker: { sessionId: string }) => worker.sessionId === targetId)).toBe(
      visible,
    );
    expect(results[1]!.role === "toolResult" && !!results[1]!.isError).toBe(!visible);
  };
  await check(false);
  await probe({
    action: "resume",
    sessionId: String(reader.id),
    prompt: "reader assignment",
    workspaceId: "other",
  });
  await check(true);
  await probe({
    action: "resume",
    sessionId: String(reader.id),
    prompt: "reader assignment",
    workspaceId: "test",
  });
  await check(false);
});

test("cron descendants in the assistant workspace discover only their own run tree", async () => {
  const { faux, orchestration, open } = await fixture(10_000, console.error, "test");
  const { harness, main } = await open();
  faux.setResponses(
    Array.from({ length: 50 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("probe:"))
        return call(JSON.parse((last.content as string).slice(6)));
      if (last.role === "user" && text.includes("hidden cron"))
        return call({ action: "run", prompt: "hidden helper", workspaceId: "test" });
      if (last.role === "user" && text.includes("hidden helper")) return call({ action: "list" });
      return done();
    }),
  );
  const job = await orchestration.addJob({
    prompt: "hidden cron",
    workspaceId: "test",
    session: { kind: "daily-detached" },
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  await orchestration.tick();
  await until(async () => (await orchestration.listRunningCron()).length === 0);
  await main.waitForIdle(context);
  const state = await orchestrationHistory(harness);
  const helper = Object.values(state.workers).find((worker) => worker.prompt === "hidden helper")!;
  expect(helper).toBeDefined();
  const helperMessages = (await (await harness.conversation(helper.id, context))!.context(context))
    .messages;
  const denied = helperMessages.find(
    (message) => message.role === "toolResult" && message.toolName === "subagent",
  );
  expect(denied?.role === "toolResult" && !!denied.isError).toBe(false);
  expect(JSON.parse((denied!.content[0] as { text: string }).text).workers).toEqual(
    expect.arrayContaining([expect.objectContaining({ sessionId: String(helper.id) })]),
  );
  for (const args of [
    { action: "list", limit: 100 },
    { action: "inspect", sessionId: String(helper.id) },
  ]) {
    await (
      await main.submit({ type: "input", content: `probe:${JSON.stringify(args)}` }, context)
    ).wait(context);
    const result = (await main.context(context)).messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "subagent",
    )!;
    if (args.action === "list")
      expect(JSON.parse((result.content[0] as { text: string }).text).workers).toEqual([]);
    else expect(result.role === "toolResult" && result.isError).toBe(true);
  }
});

test("cron discovery separates runs of the same job and other jobs across nested workspace moves", async () => {
  const { faux, orchestration, open } = await fixture(10_000, console.error, "test");
  const { harness, main } = await open();
  faux.setResponses(
    Array.from({ length: 300 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("probe:"))
        return call(JSON.parse((last.content as string).slice(6)));
      if (last.role === "user" && text.includes("cron root"))
        return call({ action: "run", prompt: "cron child", workspaceId: "other", async: false });
      if (last.role === "user" && text.includes("cron child"))
        return call({
          action: "run",
          prompt: "cron grandchild",
          workspaceId: "test",
          async: false,
        });
      return done();
    }),
  );
  const job = await orchestration.addJob({
    prompt: "cron root",
    workspaceId: "test",
    session: { kind: "daily-detached" },
    schedule: { kind: "every", every: "1h" },
  });
  const otherJob = await orchestration.addJob({
    prompt: "cron root",
    workspaceId: "other",
    session: { kind: "daily-detached" },
    schedule: { kind: "at", in: "1h" },
  });
  const fire = async (jobId: string, scheduledAt: number) => {
    const before = Object.keys((await orchestrationHistory(harness)).workers);
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[jobId]!.nextAt = scheduledAt;
    }, context);
    await orchestration.tick();
    await until(async () => (await orchestration.listRunningCron()).length === 0);
    await main.waitForIdle(context);
    const added = Object.values((await orchestrationHistory(harness)).workers).filter(
      (worker) => !before.includes(String(worker.id)),
    );
    expect(added).toHaveLength(3);
    return added;
  };
  const first = await fire(job.id, Date.now() - 3000);
  const second = await fire(job.id, Date.now() - 2000);
  const third = await fire(otherJob.id, Date.now() - 1000);
  // An ordinary assistant-workspace reader must not see any cron run.
  await (
    await main.submit(
      {
        type: "input",
        content: `probe:${JSON.stringify({
          action: "run",
          prompt: "ordinary",
          workspaceId: "test",
        })}`,
      },
      context,
    )
  ).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  const ordinary = Object.values((await orchestrationHistory(harness)).workers).find(
    (worker) => worker.prompt === "ordinary",
  )!;
  const probe = async (reader: typeof ordinary, args: Record<string, JsonValue>) => {
    const conversation = (await harness.conversation(reader.id, context))!;
    await (
      await conversation.submit(
        { type: "input", content: `probe:${JSON.stringify(args)}` },
        context,
      )
    ).wait(context);
    const result = (await conversation.context(context)).messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "subagent",
    )!;
    return result;
  };
  for (const group of [first, second, third, [ordinary]]) {
    for (const reader of group) {
      const result = await probe(reader, { action: "list", limit: 100 });
      const listed = JSON.parse((result.content[0] as { text: string }).text).workers;
      expect(listed.map((worker: { sessionId: string }) => worker.sessionId).sort()).toEqual(
        group.map((worker) => String(worker.id)).sort(),
      );
      for (const target of [...first, ...second, ...third, ordinary]) {
        const inspected = await probe(reader, { action: "inspect", sessionId: String(target.id) });
        expect(inspected.role === "toolResult" && !!inspected.isError).toBe(
          !group.includes(target),
        );
      }
    }
  }
  const grandchild = first.find((worker) => worker.prompt === "cron grandchild")!;
  await (
    await main.submit(
      {
        type: "input",
        content: `probe:${JSON.stringify({
          action: "resume",
          sessionId: String(grandchild.id),
          prompt: "moved",
          workspaceId: "other",
        })}`,
      },
      context,
    )
  ).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  const moved = await probe(grandchild, { action: "list", limit: 100 });
  expect(
    JSON.parse((moved.content[0] as { text: string }).text)
      .workers.map((worker: { sessionId: string }) => worker.sessionId)
      .sort(),
  ).toEqual(first.map((worker) => String(worker.id)).sort());
});

test("inspect authorizes against the same snapshot as output during a workspace-changing resume", async () => {
  const { faux, registry, orchestration, open } = await fixture();
  const subagent = orchestration.extension.tools!.find((tool) => tool.name === "subagent")!;
  const executeSubagent = subagent.execute as (
    args: {
      action: "inspect" | "queue";
      sessionId: string;
      prompt?: string;
      workspaceId?: string;
    },
    api: Parameters<typeof subagent.execute>[1],
    ctx: Parameters<typeof subagent.execute>[2],
  ) => ReturnType<typeof subagent.execute>;
  let targetId: string;
  let resumed = false;
  let paused = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.install(
    defineExtension({
      name: "inspect-race-fixture",
      tools: [
        defineTool({
          name: "target-pause",
          description: "Hold target in its first assignment",
          parameters: Type.Object({}),
          execute: async () => {
            paused = true;
            await gate;
            return { output: [{ type: "text", text: "released" }] };
          },
        }),
        defineTool({
          name: "racing-inspect",
          description: "Inspect across a concurrent workspace move",
          parameters: Type.Object({}),
          execute: async (_, api, ctx) =>
            executeSubagent(
              { action: "inspect", sessionId: targetId },
              {
                ...api,
                snapshot: (async (...parameters: unknown[]) => {
                  const snapshot = await (api.snapshot as (...args: unknown[]) => Promise<unknown>)(
                    ...parameters,
                  );
                  if (parameters[0] === OrchestrationDoc && !resumed) {
                    resumed = true;
                    await executeSubagent(
                      {
                        action: "queue",
                        sessionId: targetId,
                        prompt: "moved target",
                        workspaceId: "other",
                      },
                      api,
                      ctx,
                    );
                    release();
                    await until(async () => {
                      const metadata = await api.snapshot(
                        WorkerDoc,
                        Number(targetId) as typeof api.conversationId,
                        ctx,
                      );
                      return (
                        metadata?.workspaceId === "other" &&
                        metadata.latestReport?.text === "workspace B private report"
                      );
                    });
                  }
                  return snapshot;
                }) as typeof api.snapshot,
              },
              ctx,
            ),
        }),
      ],
    }),
  );
  const { harness, main } = await open();
  faux.setResponses([
    call({ action: "run", prompt: "target", workspaceId: "test" }),
    ...Array.from(
      { length: 10 },
      () => (request: { messages: readonly { role: string; content: unknown }[] }) => {
        const last = request.messages.findLast((message) => message.role !== "system")!;
        if (last.role === "user" && JSON.stringify(last.content).includes("target"))
          return fauxAssistantMessage([fauxToolCall("target-pause", {})], {
            stopReason: "toolUse",
          });
        return done();
      },
    ),
  ]);
  await (await main.submit({ type: "input", content: "create target" }, context)).wait(context);
  await until(async () => paused);
  await main.waitForIdle(context);
  targetId = String(Object.values((await orchestrationHistory(harness)).workers)[0]!.id);
  faux.setResponses([
    call({ action: "run", prompt: "inspector", workspaceId: "test" }),
    ...Array.from(
      { length: 30 },
      () => (request: { messages: readonly { role: string; content: unknown }[] }) => {
        const last = request.messages.findLast((message) => message.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("inspector"))
          return fauxAssistantMessage([fauxToolCall("racing-inspect", {})], {
            stopReason: "toolUse",
          });
        if (last.role === "user" && text.includes("moved target"))
          return call({ action: "report", prompt: "workspace B private report" });
        return done();
      },
    ),
  ]);
  await (await main.submit({ type: "input", content: "create inspector" }, context)).wait(context);
  await until(async () => resumed && (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  const inspector = Object.values((await orchestrationHistory(harness)).workers).find(
    (worker) => worker.prompt === "inspector",
  )!;
  const messages = (await (await harness.conversation(inspector.id, context))!.context(context))
    .messages;
  const result = messages.find(
    (message) => message.role === "toolResult" && message.toolName === "racing-inspect",
  );
  expect(result?.role === "toolResult" && result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("Unknown or inaccessible subagent");
  expect(JSON.stringify(messages)).not.toContain("workspace B private report");
});
