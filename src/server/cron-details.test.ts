import Fastify from "fastify";
import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fixture, until } from "./orchestration-test-fixture";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { OrchestrationDoc } from "./orchestration";
import { registerCronRoutes } from "./routes/cron";
import { parseCronArgs } from "./cron-cli";

test("compact cron list and explicit details preserve full jobs and workspace filtering", async () => {
  const { orchestration, open } = await fixture();
  const { main } = await open();
  const app = Fastify();
  registerCronRoutes(app, orchestration);
  const request = async (body: object) => {
    const response = await app.inject({ method: "POST", url: "/api/cron", payload: body });
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  try {
    const first = await request({
      action: "add",
      title: "  Weekly review  ",
      prompt: "A very detailed private prompt",
      workspaceId: "test",
      schedule: { kind: "at", in: "1h" },
    });
    const second = await orchestration.addJob({
      title: "Other review",
      prompt: "Other private prompt",
      workspaceId: "other",
      schedule: { kind: "every", every: "1h" },
    });
    const retryAt = Date.now() + 60000;
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[first.id]!.retryAt = retryAt;
    }, context);
    const before = await request({ action: "get", jobId: first.id });
    await request({ action: "update", jobId: first.id, title: "Renamed review" });
    const full = await request({ action: "get", jobId: first.id });
    expect(full).toEqual({ ...before, title: "Renamed review", updatedAt: full.updatedAt });
    const list = await request({ action: "list" });
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      id: first.id,
      title: "Renamed review",
      workspaceId: "test",
      enabled: true,
      schedule: first.schedule,
      nextAt: first.nextAt,
      retryAt,
    });
    expect(JSON.stringify(list)).not.toContain("private prompt");
    expect(await request({ action: "list", workspaceId: "other" })).toEqual([
      {
        id: second.id,
        title: second.title,
        workspaceId: "other",
        enabled: true,
        schedule: second.schedule,
        nextAt: second.nextAt,
      },
    ]);
    expect(full.prompt).toBe("A very detailed private prompt");
    expect(full).not.toHaveProperty("session");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/cron",
          payload: { action: "get", jobId: "missing" },
        })
      ).statusCode,
    ).toBe(500);
  } finally {
    await app.close();
  }
});

test("AI cron list defaults to all workspaces and preserves explicit filters", async () => {
  const { orchestration, open, faux } = await fixture(10000, console.error, "test");
  const { main } = await open();
  const cron = orchestration.extension.tools!.find((tool) => tool.name === "cron")!;
  await main.configure({ extensions: [orchestration.extension], tools: [cron] }, context);
  const jobs = await Promise.all(
    ["test", "other"].map((workspaceId) =>
      orchestration.addJob({
        title: workspaceId,
        prompt: "Private prompt",
        workspaceId,
        schedule: { kind: "at", in: "1h" },
      }),
    ),
  );
  for (const workspaceId of [undefined, "other"]) {
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("cron", { action: "list", ...(workspaceId ? { workspaceId } : {}) })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Listed.")]),
    ]);
    await (
      await main.submit({ type: "input", content: "List scheduled tasks" }, context)
    ).wait(context);
    const result = (await main.context(context)).messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "cron",
    );
    expect(result?.role).toBe("toolResult");
    if (result?.role !== "toolResult") throw new Error("Missing cron result");
    const text = result.content.find((block) => block.type === "text");
    if (text?.type !== "text") throw new Error("Missing cron output");
    const summaries = JSON.parse(text.text);
    expect(summaries.map((job: { id: string }) => job.id).sort()).toEqual(
      jobs
        .filter((job) => !workspaceId || job.workspaceId === workspaceId)
        .map((job) => job.id)
        .sort(),
    );
    expect(text.text).not.toContain("Private prompt");
  }
});

test("cron requires explicit nonblank titles on creation, import and rename", async () => {
  const { orchestration, open } = await fixture();
  await open();
  const input = { title: "Review", prompt: "Prompt", schedule: { kind: "at" as const, in: "1h" } };
  await expect(orchestration.addJob({ ...input, title: " " })).rejects.toThrow("title");
  await expect(orchestration.addJob({ ...input, title: undefined! })).rejects.toThrow("title");
  const job = await orchestration.addJob(input);
  await expect(orchestration.updateJob(job.id, { title: "" })).rejects.toThrow("title");
  await expect(orchestration.importJob({ ...job, id: "invalid", title: "" })).rejects.toThrow(
    "title",
  );
  expect((await orchestration.getJob(job.id)).title).toBe("Review");
});

test("renaming an executing one-shot preserves successful retirement", async () => {
  const { orchestration, open, faux } = await fixture(50);
  const { main } = await open();
  faux.setResponses([
    fauxAssistantMessage([
      fauxText("A sufficiently long worker reply to keep the run active while its title changes."),
    ]),
    fauxAssistantMessage([fauxText("Result received.")]),
  ]);
  const job = await orchestration.addJob({
    title: "One-shot",
    prompt: "Complete this task",
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  await orchestration.tick();
  const [run] = await orchestration.listRunningCron(job.id);
  expect(run).toBeDefined();
  await until(async () => Date.now() > run!.startedAt);
  const renamed = await orchestration.updateJob(job.id, { title: "Renamed one-shot" });
  expect(renamed.updatedAt).toBe(job.updatedAt);
  await until(async () => (await orchestration.listRunLogs(job.id))[0]?.status === "completed");
  expect(await orchestration.listJobs()).toEqual([]);
  await expect(orchestration.getJob(job.id)).rejects.toThrow("Unknown cron job");
}, 15000);

test("cron CLI supports all-workspace listing, filtering, get and title updates", async () => {
  expect((await parseCronArgs(["cron", "list"])).body).toEqual({ action: "list" });
  expect((await parseCronArgs(["cron", "list", "--workspace", "other"])).body).toEqual({
    action: "list",
    workspaceId: "other",
  });
  expect((await parseCronArgs(["cron", "get", "job-id"])).body).toEqual({
    action: "get",
    jobId: "job-id",
  });
  expect((await parseCronArgs(["cron", "update", "job-id", "--title", "Review"])).body).toEqual({
    action: "update",
    jobId: "job-id",
    title: "Review",
  });
});
