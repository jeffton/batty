import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

import { Type, getCurrentTools } from "@earendil-works/pi-ai";

import { OrchestrationDoc } from "./orchestration.js";
import { orchestrationHistory } from "./orchestration-test-history";

import { fixture, until } from "./orchestration-test-fixture.js";

test.each(["complete", "cancel", "restart"] as const)(
  "inline scoped extension/tool selection restores after %s",
  async (mode) => {
    const { faux, orchestration, open, registry, directory } = await fixture(
      mode === "complete" ? 10000 : 200,
    );
    let executed = false;
    const scoped = defineTool({
      name: "inline_scope",
      description: "scope",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_, api) => {
        executed = true;
        return { output: [{ type: "text", text: `scoped:${api.env!.cwd}` }] };
      },
    });
    const scopedExtension = defineExtension({ name: "inline-mcp-scope", tools: [scoped] });
    registry.install(scopedExtension);
    let { harness, main } = await open();
    const cronTool = orchestration.extension.tools!.find((tool) => tool.name === "cron")!;
    await main.configure(
      { cwd: "/tmp", extensions: [orchestration.extension], tools: [cronTool] },
      context,
    );
    const prepared: { cwd: string; actualCwd: string | undefined }[] = [];
    orchestration.setPrepareAgent(async (cwd, agent) => {
      prepared.push({ cwd, actualCwd: agent.cwd });
      return { extensions: [...agent.extensions, scopedExtension], tools: [scoped] };
    });
    let finalStarted = false;
    faux.setResponses([
      (request) => {
        expect(getCurrentTools(request.messages).map((tool) => tool.name)).toEqual([
          "inline_scope",
        ]);
        return fauxAssistantMessage([fauxToolCall("inline_scope", {})], { stopReason: "toolUse" });
      },
      () => {
        finalStarted = true;
        return fauxAssistantMessage([
          fauxText(mode === "complete" ? "done" : "working ".repeat(1000)),
        ]);
      },
    ]);
    const job = await orchestration.addJob({
      workspaceId: "test",
      prompt: "use scoped inline tools",
      session: { kind: "main-inline" },
      schedule: { kind: "at", in: "1h" },
    });
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    await until(async () => finalStarted);
    expect(executed).toBe(true);
    if (mode === "cancel") {
      const run = (await orchestration.listRunningCron())[0]!;
      await orchestration.stopRunning(run.id);
    } else if (mode === "restart") {
      await harness.close(context);
      faux.setResponses([fauxAssistantMessage([fauxText("recovered scoped result")])]);
      ({ harness, main } = await open());
      harness.resume();
    }
    await until(
      async () =>
        (await orchestration.listRunLogs())[0]?.status ===
        (mode === "cancel" ? "aborted" : "completed"),
    );
    expect(prepared).toEqual([{ cwd: directory, actualCwd: "/tmp" }]);
    const agent = await main.agent(context);
    expect(agent.extensions.map((extension) => extension.name)).toEqual([
      orchestration.extension.name,
    ]);
    expect(agent.tools.map((tool) => tool.name)).toEqual(["cron"]);
    expect(agent.cwd).toBe("/tmp");
  },
  15000,
);

test("inline cron tools use the originating workspace and restore main cwd", async () => {
  const { faux, orchestration, open, registry, directory } = await fixture();
  registry.install(
    defineExtension({
      name: "cwd-test",
      tools: [
        defineTool({
          name: "where",
          description: "cwd",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async (_, api) => ({ output: [{ type: "text", text: api.env!.cwd }] }),
        }),
      ],
    }),
  );
  const { main } = await open();
  await main.configure({ cwd: "/tmp" }, context);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("where", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("finished")]),
  ]);
  const job = await orchestration.addJob({
    workspaceId: "test",
    prompt: "inspect cwd",
    session: { kind: "daily-inline" },
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  await orchestration.tick();
  await until(async () => (await orchestration.listRunLogs())[0]?.status === "completed");
  const result = (await main.context(context)).messages.find((m) => m.role === "toolResult");
  expect(JSON.stringify(result)).toContain(JSON.stringify(directory).slice(1, -1));
  expect((await main.agent(context)).cwd).toBe("/tmp");
  expect(await orchestration.listRunning()).toHaveLength(0);
}, 15000);

test("inline workspace context survives a steer and subsequent tool round", async () => {
  const { faux, orchestration, open, registry, directory } = await fixture();
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.install(
    defineExtension({
      name: "inline-steer-test",
      tools: [
        defineTool({
          name: "where",
          description: "cwd",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async (_, api) => {
            seen.push(api.env!.cwd);
            if (seen.length === 1) await gate;
            return { output: [{ type: "text", text: api.env!.cwd }] };
          },
        }),
      ],
    }),
  );
  const { main } = await open();
  await main.configure({ cwd: "/tmp" }, context);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("where", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("where", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("finished")]),
  ]);
  const job = await orchestration.addJob({
    workspaceId: "test",
    prompt: "inspect cwd twice",
    session: { kind: "main-inline" },
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  await orchestration.tick();
  try {
    await until(async () => seen.length === 1);
    await main.submit(
      {
        type: "input",
        content: "additional instructions without a cron marker",
        whenBusy: "steer",
      },
      context,
    );
  } finally {
    release();
  }
  await until(async () => (await orchestration.listRunLogs())[0]?.status === "completed");
  expect(seen).toEqual([directory, directory]);
  expect((await main.agent(context)).cwd).toBe("/tmp");
}, 15000);

test("stopping a waiting inline cron does not abort main or withdraw ordinary queued input", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  registry.install(
    defineExtension({
      name: "main-gate",
      tools: [
        defineTool({
          name: "gate",
          description: "gate",
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
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("gate", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("user answer")]),
    fauxAssistantMessage([fauxText("queued user answer")]),
  ]);
  const user = await main.submit({ type: "input", content: "ordinary user task" }, context);
  try {
    await until(async () => entered);
    const queuedUser = await main.submit(
      { type: "input", content: "ordinary queued user" },
      context,
    );
    const job = await orchestration.addJob({
      prompt: "cron must not start",
      session: { kind: "main-inline" },
      schedule: { kind: "at", in: "1h" },
    });
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    const run = (await orchestration.listRunningCron())[0]!;
    const scheduledJob = (await orchestration.listJobs()).find((entry) => entry.id === job.id);
    await orchestration.stopRunning(run.id);
    await until(async () => (await orchestration.listRunLogs())[0]?.status === "aborted");
    expect((await orchestration.listJobs()).find((entry) => entry.id === job.id)).toEqual(
      scheduledJob,
    );
    expect((await user.status(context)).status).toBe("placed");
    expect((await queuedUser.status(context)).status).toBe("queued");
    release();
    expect((await user.wait(context)).status).toBe("done");
    expect((await queuedUser.wait(context)).status).toBe("done");
  } finally {
    release();
  }
}, 15000);

test("inline model/thinking overrides survive restart and restore the main agent", async () => {
  const { faux, orchestration, open } = await fixture(100);
  let { harness, main } = await open();
  await main.configure({ cwd: "/tmp", thinkingLevel: "low" }, context);
  const seen: { model: string; reasoning: unknown }[] = [];
  faux.setResponses([
    (request, options, _, model) => {
      seen.push({ model: model.id, reasoning: options?.reasoning });
      return fauxAssistantMessage([fauxText("working ".repeat(1000))]);
    },
  ]);
  const job = await orchestration.addJob({
    prompt: "scoped cron",
    model: "faux/faux-2",
    thinkingLevel: "high",
    session: { kind: "main-inline" },
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  await orchestration.tick();
  await until(async () => seen.length === 1);
  expect((await main.agent(context)).model?.modelId).toBe("faux-2");
  await harness.close(context);
  faux.setResponses([
    (request, options, _, model) => {
      seen.push({ model: model.id, reasoning: options?.reasoning });
      return fauxAssistantMessage([fauxText("recovered inline result")]);
    },
  ]);
  ({ harness, main } = await open());
  harness.resume();
  await until(async () => (await orchestration.listRunLogs())[0]?.status === "completed");
  expect(seen).toEqual([
    { model: "faux-2", reasoning: "high" },
    { model: "faux-2", reasoning: "high" },
  ]);
  expect(await main.agent(context)).toMatchObject({
    cwd: "/tmp",
    model: { modelId: "faux-1" },
    thinkingLevel: "low",
  });
  expect((await orchestrationHistory(harness))!.inlineContext).toBeUndefined();
}, 15000);

test("an admitted legacy inline cron retains its workspace after restart", async () => {
  const { faux, open } = await fixture(100);
  let { harness, main } = await open();
  await main.configure({ cwd: "/tmp" }, context);
  let requests = 0;
  faux.setResponses([
    () => {
      requests++;
      return fauxAssistantMessage([fauxText("working ".repeat(1000))]);
    },
  ]);
  const marker = `<batty-cron-context>${JSON.stringify({ cwd: "/var/tmp", runId: "legacy-run" })}</batty-cron-context>\nlegacy cron task`;
  await main.submit({ type: "input", content: marker }, context);
  await until(async () => requests === 1);
  expect((await main.agent(context)).cwd).toBe("/var/tmp");
  await harness.close(context);
  faux.setResponses([
    async () => {
      expect((await main.agent(context)).cwd).toBe("/var/tmp");
      return fauxAssistantMessage([fauxText("legacy task completed")]);
    },
  ]);
  ({ harness, main } = await open());
  harness.resume();
  await main.waitForIdle(context);
  expect((await main.agent(context)).cwd).toBe("/tmp");
}, 15000);

test("stopping an active inline cron preserves queued user input and restores scoped settings", async () => {
  const { faux, orchestration, open } = await fixture(100);
  const { main } = await open();
  await main.configure({ cwd: "/tmp", thinkingLevel: "low" }, context);
  let entered = false;
  faux.setResponses([
    () => {
      entered = true;
      return fauxAssistantMessage([fauxText("working ".repeat(1000))]);
    },
  ]);
  const job = await orchestration.addJob({
    prompt: "cancel scoped cron",
    model: "faux/faux-2",
    thinkingLevel: "high",
    session: { kind: "main-inline" },
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  await orchestration.tick();
  await until(async () => entered);
  const queued = await main.submit(
    { type: "input", content: "unrelated ordinary queued user" },
    context,
  );
  const run = (await orchestration.listRunningCron())[0]!;
  await orchestration.stopRunning(run.id);
  await until(async () => (await orchestration.listRunLogs())[0]?.status === "aborted");
  expect((await queued.status(context)).status).toBe("queued");
  expect(await main.agent(context)).toMatchObject({
    cwd: "/tmp",
    model: { modelId: "faux-1" },
    thinkingLevel: "low",
  });
  faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage([fauxText("done")])));
  await main.submit({ type: "input", content: "continue normal work" }, context);
  expect((await queued.wait(context)).status).toBe("done");
}, 15000);
