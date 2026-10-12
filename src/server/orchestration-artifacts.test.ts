import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

import { Type } from "@earendil-works/pi-ai";

import { OrchestrationDoc } from "./orchestration.js";
import { orchestrationHistory } from "./orchestration-test-history";

import { decodeRuntimeNotice } from "./runtime-notices.js";

import { entryMessages } from "./runtime.js";

import { artifactRefs } from "./artifact-forwarding";

import { fixture, until } from "./orchestration-test-fixture.js";

test.each(
  ([false, true] as const).flatMap((sync) =>
    (["assistant", "direct"] as const).map((delivery) => [sync, delivery] as const),
  ),
)(
  "cron preserves helper artifacts through synchronous=%s joins, delivery=%s",
  async (sync, delivery) => {
    const { faux, orchestration, open, registry } = await fixture();
    const file = {
      id: "f",
      storedPath: "/var/lib/batty2/sent-files/child/Cabin.jpg",
      name: "Cabin.jpg",
      size: 1,
      mimeType: "image/jpeg",
      kind: "image",
      downloadUrl: "/api/sent-files/f",
    };
    const site = { id: "s", name: "Site", url: "/api/sites/s", public: false };
    registry.install(
      defineExtension({
        name: "artifact-fixture",
        tools: [
          defineTool({
            name: "emit-artifacts",
            description: "Emit artifacts",
            parameters: Type.Object({}),
            execute: async () => ({
              content: [{ type: "text", text: "Emitted" }],
              details: {
                sentFiles: [file],
                sites: [site],
                battyFileChanges: [
                  { path: "a.ts", before: "before\n", after: "after\n", patch: "unused" },
                ],
              },
            }),
          }),
        ],
      }),
    );
    const { main } = await open();
    let joinedModelInput = "";
    let reportModelInput = "";
    faux.setResponses(
      Array.from({ length: 30 }, () => (request) => {
        const last = request.messages.findLast((m) => m.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "toolResult" && text.includes("helper done")) joinedModelInput = text;
        if (last.role === "user" && text.includes("cron finished")) reportModelInput = text;
        if (last.role === "user" && text.includes("artifact outer"))
          return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "run", prompt: "artifact inner", async: !sync })],
            { stopReason: "toolUse" },
          );
        if (last.role === "user" && text.includes("artifact inner"))
          return fauxAssistantMessage([fauxToolCall("emit-artifacts", {})], {
            stopReason: "toolUse",
          });
        if (last.role === "toolResult" && last.toolName === "emit-artifacts")
          return fauxAssistantMessage([fauxText("helper done")]);
        if (
          last.role === "toolResult" &&
          last.toolName === "subagent" &&
          text.includes("Started")
        ) {
          const sessionId = text.match(/Session ID: (\d+)/)![1]!;
          return fauxAssistantMessage([fauxToolCall("subagent", { action: "await", sessionId })], {
            stopReason: "toolUse",
          });
        }
        return fauxAssistantMessage([fauxText("cron finished")]);
      }),
    );
    const job = await orchestration.addJob({
      workspaceId: "test",
      prompt: "artifact outer",
      delivery,
      schedule: { kind: "at", in: "1h" },
    });
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    await until(async () => (await orchestration.listRunLogs())[0]?.status === "completed");
    await main.waitForIdle(context);
    const reports = (await main.context(context)).messages
      .filter((m) => m.role === "user")
      .map((m) => decodeRuntimeNotice(m.content))
      .filter((notice) => notice?.data?.runtimeNotice);
    if (delivery === "direct") {
      expect(reports).toHaveLength(0);
      expect(
        entryMessages((await main.context(context)).entries).findLast(
          (message) => message.role === "assistant",
        ),
      ).toMatchObject({
        blocks: [fauxText("cron finished")],
        sentFiles: [file],
        sites: [site],
        fileChanges: [{ path: "a.ts" }],
      });
      const directNotice = (await main.context(context)).messages
        .filter((message) => message.role === "user")
        .map((message) => decodeRuntimeNotice(message.content))
        .find((notice) => notice?.data?.directDelivery);
      expect(directNotice!.data!.directDelivery).toEqual({ text: "cron finished" });
      const directArtifacts = directNotice!.data!.runtimeResultArtifacts as Parameters<
        typeof artifactRefs
      >[0];
      expect(
        artifactRefs(directArtifacts)
          .map((item) => item.kind)
          .sort(),
      ).toEqual(["diff", "file", "site"]);
      for (const item of artifactRefs(directArtifacts))
        expect(directNotice!.text).toContain(item.ref);
      expect(directNotice!.text).toContain("call attach_artifacts");
      expect(joinedModelInput).toContain(file.storedPath);
      expect(joinedModelInput).toContain("call attach_artifacts");
      expect(joinedModelInput).toContain("diff:");
      expect(joinedModelInput).toContain("site:");
      return;
    }
    expect(reports).toHaveLength(1);
    expect(reports[0]!.data!.runtimeResultArtifacts).toMatchObject({
      sentFiles: [file],
      sites: [site],
      fileChanges: [{ path: "a.ts" }],
    });
    expect(JSON.stringify(reports[0])).toContain("-before");
    for (const input of [joinedModelInput, reportModelInput]) {
      expect(input).toContain(file.storedPath);
      expect(input).toContain(file.name);
      expect(input).toContain("Use attach_files to import local files by path");
      expect(input).toContain("Copying attachment:// links does not deliver attachments");
      expect(input).toContain("call attach_artifacts");
      expect(input).toContain("diff:");
      expect(input).toContain("site:");
    }
  },
  15000,
);

test("async subagent reports expose stored attachment paths in parent model input", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  const file = {
    id: "child-file",
    name: "chosen.png",
    storedPath: "/var/lib/batty2/sent-files/child/chosen.png",
    size: 1,
    mimeType: "image/png",
    kind: "image",
    downloadUrl: "/api/sent-files/child-file",
  };
  registry.install(
    defineExtension({
      name: "async-attachment-fixture",
      tools: [
        defineTool({
          name: "attach-fixture",
          description: "Emit a child attachment",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text", text: "Attached" }],
            details: {
              sentFiles: [file],
              sites: [{ id: "async-site", name: "Async demo", url: "/async-site", public: false }],
              fileChanges: [{ path: "async.ts", patch: "saved patch" }],
            },
          }),
        }),
      ],
    }),
  );
  const { main } = await open();
  let reportInput = "";
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      const last = request.messages.findLast((m) => m.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("start attachment worker"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "run", prompt: "produce attachment" })],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("produce attachment"))
        return fauxAssistantMessage([fauxToolCall("attach-fixture", {})], {
          stopReason: "toolUse",
        });
      if (last.role === "toolResult" && last.toolName === "attach-fixture")
        return fauxAssistantMessage([fauxText("child artifact ready")]);
      if (last.role === "user" && text.includes("child artifact ready")) reportInput = text;
      return fauxAssistantMessage([fauxText("parent acknowledged")]);
    }),
  );
  await (
    await main.submit({ type: "input", content: "start attachment worker" }, context)
  ).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  expect(reportInput).toContain(file.name);
  expect(reportInput).toContain(file.storedPath);
  expect(reportInput).toContain("Use attach_files to import local files by path");
  expect(reportInput).toContain("do not automatically forward every draft");
  expect(reportInput).toContain("call attach_artifacts");
  expect(reportInput).toContain("async.ts");
  expect(reportInput).toContain("Async demo");
});

test.each([
  ["daily-detached", false],
  ["main-inline", false],
  ["daily-detached", true],
  ["main-inline", true],
] as const)(
  "cron %s joins parallel children (late=%s) and finishes postprocessing before delivery",
  async (kind, late) => {
    const { faux, orchestration, open, registry } = await fixture();
    let releaseChild!: () => void;
    let releaseParent!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    let releaseFast!: () => void;
    let releaseBetween!: () => void;
    const fastGate = new Promise<void>((resolve) => {
      releaseFast = resolve;
    });
    const betweenGate = new Promise<void>((resolve) => {
      releaseBetween = resolve;
    });
    let continuing = false;
    let processing = false;
    registry.install(
      defineExtension({
        name: "parallel-join-test",
        tools: [
          defineTool({
            name: "join_gate",
            description: "hold child or postprocessing",
            parameters: Type.Object({
              parent: Type.Boolean(),
              fast: Type.Optional(Type.Boolean()),
              between: Type.Optional(Type.Boolean()),
            }),
            replay: "safe",
            execute: async ({ parent, fast, between }) => {
              if (fast) {
                await fastGate;
                return { content: [{ type: "text", text: "fast ready" }] };
              }
              if (between) {
                continuing = true;
                await betweenGate;
                return { content: [{ type: "text", text: "continue joins" }] };
              }
              if (parent) processing = true;
              await (parent ? parentGate : childGate);
              return { content: [{ type: "text", text: parent ? "processed" : "child ready" }] };
            },
          }),
        ],
      }),
    );
    const { harness, main } = await open();
    const call = (args: { action: string; sessionId: string }) =>
      fauxAssistantMessage([fauxToolCall("subagent", args)], { stopReason: "toolUse" });
    faux.setResponses(
      Array.from({ length: 60 }, () => (request) => {
        const last = request.messages.findLast((m) => m.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("parallel cron"))
          return fauxAssistantMessage(
            [
              fauxToolCall("subagent", {
                action: "run",
                async: true,
                prompt: "slow parallel child",
              }),
              fauxToolCall("subagent", {
                action: "run",
                async: true,
                prompt: "fast parallel child",
              }),
            ],
            { stopReason: "toolUse" },
          );
        if (last.role === "user" && text.includes("slow parallel child"))
          return fauxAssistantMessage([fauxToolCall("join_gate", { parent: false })], {
            stopReason: "toolUse",
          });
        if (last.role === "user" && text.includes("fast parallel child"))
          return late
            ? fauxAssistantMessage([fauxToolCall("join_gate", { parent: false, fast: true })], {
                stopReason: "toolUse",
              })
            : fauxAssistantMessage([fauxText("fast findings")]);
        if (last.role === "toolResult" && text.includes("fast ready"))
          return fauxAssistantMessage([fauxText("fast findings")]);
        if (last.role === "toolResult" && text.includes("Started. Session ID:")) {
          const started = request.messages.filter(
            (m) =>
              m.role === "toolResult" && JSON.stringify(m.content).includes("Started. Session ID:"),
          );
          return call({
            action: "await",
            sessionId: JSON.stringify(started[0]!.content).match(/Session ID: (\d+)/)![1]!,
          });
        }
        if (last.role === "toolResult" && text.includes("child ready"))
          return fauxAssistantMessage([fauxText("slow findings")]);
        if (last.role === "toolResult" && text.includes("slow findings") && late)
          return fauxAssistantMessage(
            [fauxToolCall("join_gate", { parent: false, between: true })],
            { stopReason: "toolUse" },
          );
        if (
          last.role === "toolResult" &&
          (text.includes("slow findings") || text.includes("continue joins"))
        ) {
          const started = request.messages.filter(
            (m) =>
              m.role === "toolResult" && JSON.stringify(m.content).includes("Started. Session ID:"),
          );
          return call({
            action: "await",
            sessionId: JSON.stringify(started[1]!.content).match(/Session ID: (\d+)/)![1]!,
          });
        }
        if (last.role === "toolResult" && text.includes("fast findings"))
          return fauxAssistantMessage([fauxToolCall("join_gate", { parent: true })], {
            stopReason: "toolUse",
          });
        if (last.role === "toolResult" && text.includes("processed"))
          return fauxAssistantMessage([fauxText("combined cron final")]);
        return fauxAssistantMessage([fauxText("noted")]);
      }),
    );
    const job = await orchestration.addJob({
      prompt: "parallel cron",
      session: { kind: kind as "daily-detached" | "main-inline" },
      schedule: { kind: "at", in: "1h" },
    });
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    try {
      await until(async () => {
        const state = (await orchestrationHistory(harness))!;
        const fast = Object.values(state.workers).find((w) => w.prompt === "fast parallel child");
        return (
          !!fast?.active &&
          (late || (await harness.getTask(fast.active, context))?.state.status === "terminal") &&
          Object.keys(state.joins ?? {}).length > 0
        );
      });
      expect(await orchestration.listRunningCron()).toHaveLength(1);
      releaseChild();
      if (late) {
        await until(async () => continuing);
        releaseFast();
        await until(async () => {
          const state = (await orchestrationHistory(harness))!;
          const fast = Object.values(state.workers).find(
            (w) => w.prompt === "fast parallel child",
          )!;
          return (await harness.getTask(fast.active!, context))?.state.status === "terminal";
        });
        releaseBetween();
      }
      await until(async () => processing);
      expect(await orchestration.listRunningCron()).toHaveLength(1);
      expect(JSON.stringify((await main.context(context)).messages)).not.toContain(
        "combined cron final",
      );
      const run = (await orchestration.listRunningCron())[0]!;
      const parent = (await harness.conversation(Number(run.sessionId) as never, context))!;
      expect(
        (await parent.context(context)).messages.filter(
          (m) => m.role === "user" && JSON.stringify(m.content).includes("findings"),
        ),
      ).toHaveLength(0);
    } finally {
      releaseChild();
      releaseParent();
      releaseFast();
      releaseBetween();
    }
    await until(async () => (await orchestration.listRunningCron()).length === 0);
    await main.waitForIdle(context);
    expect((await orchestration.listRunLogs(job.id))[0]!.output).toBe("combined cron final");
    if (kind === "daily-detached")
      expect(
        (await main.context(context)).messages.filter(
          (m) => m.role === "user" && JSON.stringify(m.content).includes("combined cron final"),
        ),
      ).toHaveLength(1);
  },
  15000,
);
