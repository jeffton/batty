import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { fileLibraryRef, siteLibraryRef } from "@/shared/artifact-library";
import { OrchestrationDoc } from "./orchestration.js";
import { DeliveryRecord } from "./orchestration-history";
import { orchestrationHistory } from "./orchestration-test-history";
import { decodeRuntimeNotice } from "./runtime-notices.js";
import { entryMessages } from "./runtime.js";
import { fixture, until, withAttachments } from "./orchestration-test-fixture.js";

test.each(["assistant", "direct"] as const)(
  "cron delivers only final message selections from joined worker artifacts (delivery=%s)",
  async (delivery) => {
    const file = {
      id: "f",
      storedPath: "/var/lib/batty2/sent-files/child/Cabin.jpg",
      name: "Cabin.jpg",
      size: 1,
      mimeType: "image/jpeg",
      kind: "image" as const,
      downloadUrl: "/api/sent-files/f",
    };
    const site = {
      kind: "site" as const,
      id: "s",
      name: "Finished site",
      url: "/api/sites/s",
      public: false as const,
    };
    const draft = { ...site, id: "draft", name: "Unselected draft" };
    const fileRef = fileLibraryRef(file.id);
    const siteRef = siteLibraryRef(site.id);
    const { faux, orchestration, open, registry } = await fixture(
      10_000,
      console.error,
      undefined,
      undefined,
      async (_, { artifactRefs }) => {
        switch (artifactRefs?.join(",")) {
          case [fileRef, siteRef].join(","):
            return { sentFiles: [file], sites: [site] };
          case siteRef:
            return { sites: [site] };
          default:
            throw new Error(`Unexpected selection: ${artifactRefs}`);
        }
      },
    );
    registry.install(
      defineExtension({
        name: "artifact-fixture",
        tools: [
          defineTool({
            name: "emit-artifacts",
            description: "Create candidate artifacts",
            parameters: Type.Object({}),
            execute: async () => ({
              output: [{ type: "text", text: "Created" }],
              details: {
                sentFiles: [file],
                sites: [site, draft],
                battyFileChanges: [{ path: "a.ts", before: "before\n", after: "after\n" }],
              },
            }),
          }),
        ],
      }),
    );
    const { harness, main } = await open();
    let joinedModelInput = "";
    let reportModelInput = "";
    faux.setResponses(
      Array.from({ length: 30 }, () => (request) => {
        const last = request.messages.findLast((m) => m.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("artifact outer"))
          return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "run", prompt: "artifact inner" })],
            { stopReason: "toolUse" },
          );
        if (last.role === "user" && text.includes("artifact inner"))
          return fauxAssistantMessage([fauxToolCall("emit-artifacts", {})], {
            stopReason: "toolUse",
          });
        if (last.role === "toolResult" && last.toolName === "emit-artifacts")
          return fauxAssistantMessage([
            fauxText(withAttachments("helper done", { artifactRefs: [fileRef, siteRef] })),
          ]);
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
        if (text.includes("helper done")) joinedModelInput = text;
        if (last.role === "user" && text.includes("cron finished")) {
          reportModelInput = text;
          return fauxAssistantMessage([fauxText("report acknowledged")]);
        }
        return fauxAssistantMessage([
          fauxText(withAttachments("cron finished", { artifactRefs: [siteRef] })),
        ]);
      }),
    );
    const job = await orchestration.addJob({
      title: "Scheduled test task",
      workspaceId: "test",
      prompt: "artifact outer",
      delivery,
      schedule: { kind: "at", in: "1h" },
    });
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    await until(async () => (await orchestration.listRunLogs(job.id))[0]?.status === "completed");
    await main.waitForIdle(context);
    const run = (await orchestration.listRunLogs(job.id))[0]!;
    const receipt = await harness.snapshot(DeliveryRecord, String(run.taskId), context);
    expect(receipt?.presentation).toEqual({ sites: [site] });
    expect(receipt?.directDelivered).toBe(delivery === "direct" ? true : undefined);

    expect(joinedModelInput).toContain(fileRef);
    expect(joinedModelInput).toContain(siteRef);
    expect(joinedModelInput).not.toContain(draft.name);
    expect(joinedModelInput).not.toContain("<batty-attachments>");

    const helper = Object.values((await orchestrationHistory(harness)).workers).find(
      (worker) => worker.prompt === "artifact inner",
    )!;
    const child = (await harness.conversation(helper.id, context))!;
    expect(entryMessages((await child.context(context)).entries).at(-1)).toMatchObject({
      role: "assistant",
      blocks: [fauxText("helper done")],
      sentFiles: [file],
      sites: [site],
      fileChanges: [{ path: "a.ts" }],
    });

    const { entries, messages } = await main.context(context);
    const notices = messages
      .filter((m) => m.role === "user")
      .map((m) => decodeRuntimeNotice(m.content))
      .filter((notice) => notice?.kind === "cron");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.data?.runtimePresentation).toEqual({ sites: [site] });
    expect(notices[0]!.data?.directDelivery).toEqual(
      delivery === "direct" ? { text: "cron finished" } : undefined,
    );
    if (delivery === "assistant") {
      expect(reportModelInput).toContain(siteRef);
      expect(reportModelInput).not.toContain(fileRef);
    }
    const visible = entryMessages(entries).filter((message) => message.role === "assistant");
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      blocks: [fauxText(delivery === "direct" ? "cron finished" : "report acknowledged")],
    });
    expect(visible[0]!.sites).toEqual(delivery === "direct" ? [site] : undefined);
    expect(visible[0]!.sentFiles).toBeUndefined();
    expect(visible[0]!.fileChanges).toBeUndefined();
  },
  15000,
);

test.each([false, true] as const)(
  "cron joins parallel children (late=%s) and finishes postprocessing before delivery",
  async (late) => {
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
                return { output: [{ type: "text", text: "fast ready" }] };
              }
              if (between) {
                continuing = true;
                await betweenGate;
                return { output: [{ type: "text", text: "continue joins" }] };
              }
              if (parent) processing = true;
              await (parent ? parentGate : childGate);
              return { output: [{ type: "text", text: parent ? "processed" : "child ready" }] };
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
                prompt: "slow parallel child",
              }),
              fauxToolCall("subagent", {
                action: "run",
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
        if (text.includes("slow findings") && late)
          return fauxAssistantMessage(
            [fauxToolCall("join_gate", { parent: false, between: true })],
            { stopReason: "toolUse" },
          );
        if (text.includes("slow findings") || text.includes("continue joins")) {
          const started = request.messages.filter(
            (m) =>
              m.role === "toolResult" && JSON.stringify(m.content).includes("Started. Session ID:"),
          );
          return call({
            action: "await",
            sessionId: JSON.stringify(started[1]!.content).match(/Session ID: (\d+)/)![1]!,
          });
        }
        if (text.includes("fast findings"))
          return fauxAssistantMessage([fauxToolCall("join_gate", { parent: true })], {
            stopReason: "toolUse",
          });
        if (last.role === "toolResult" && text.includes("processed"))
          return fauxAssistantMessage([fauxText("combined cron final")]);
        return fauxAssistantMessage([fauxText("noted")]);
      }),
    );
    const job = await orchestration.addJob({
      title: "Scheduled test task",
      prompt: "parallel cron",
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
      ).toHaveLength(late ? 2 : 1);
    } finally {
      releaseChild();
      releaseParent();
      releaseFast();
      releaseBetween();
    }
    await until(async () => (await orchestration.listRunningCron()).length === 0);
    await main.waitForIdle(context);
    expect((await orchestration.listRunLogs(job.id))[0]!.output).toBe("combined cron final");
    expect(
      (await main.context(context)).messages.filter(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("combined cron final"),
      ),
    ).toHaveLength(1);
  },
  15000,
);
