import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppConfig } from "./config";
import { CronService } from "./cron-runtime";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createConfig(): Promise<AppConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-cron-runtime-"));
  tempDirs.push(root);
  await fs.mkdir(path.join(root, "alpha"));
  return {
    host: "127.0.0.1",
    port: 3147,
    workspacesRoots: [root],
    selfPath: path.join(root, "self-project"),
    battyDir: root,
    uploadsDir: path.join(root, "uploads"),
    sentFilesDir: path.join(root, "sent-files"),
    publicDir: path.join(root, "public"),
    webPushDir: path.join(root, "web-push"),
    webPushSubject: "mailto:test@example.com",
    cronDailySessionStartTime: "04:00",
    baseUrl: "/",
    appTitle: "Batty",
    appColor: "neutral",
    cookieName: "test",
    authSecret: crypto.randomUUID(),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("cron runtime", () => {
  it("does not schedule or trigger disabled jobs", async () => {
    const config = await createConfig();
    const service = new CronService(config);
    const run = vi.fn(async () => ({ sessionId: "session", sessionPath: "/tmp/session.jsonl" }));
    service.setRunner({ run });
    const job = await service.createJob({
      workspaceId: "alpha",
      enabled: false,
      prompt: "Paused job",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      schedule: { kind: "every", every: "1h" },
    });
    const internals = service as unknown as {
      scheduledHandles: Map<string, unknown>;
      triggerJob(jobId: string): Promise<void>;
    };

    expect(internals.scheduledHandles.has(job.id)).toBe(false);
    await internals.triggerJob(job.id);
    expect(run).not.toHaveBeenCalled();

    await service.updateJob(job.id, { enabled: true });
    expect(internals.scheduledHandles.has(job.id)).toBe(true);
    await internals.triggerJob(job.id);
    expect(run).toHaveBeenCalledOnce();
    expect(service.listRecentRunLogs("alpha")).toEqual([
      expect.objectContaining({
        runId: expect.any(String),
        jobId: job.id,
        status: "success",
        sessionPath: "/tmp/session.jsonl",
      }),
    ]);

    const restarted = new CronService(config);
    await restarted.initialize();
    expect(restarted.listRecentRunLogs("alpha")).toEqual([
      expect.objectContaining({ jobId: job.id, status: "success" }),
    ]);
    await restarted.dispose();
    await service.dispose();
  });

  it("marks persisted running logs as interrupted after a restart", async () => {
    const config = await createConfig();
    const service = new CronService(config);
    const result = deferred<{ sessionId: string; sessionPath: string }>();
    service.setRunner({
      run: async (_job, context) => {
        await context.onSessionStarted({
          sessionId: "interrupted-session",
          sessionPath: "/tmp/interrupted.jsonl",
        });
        return result.promise;
      },
    });
    const job = await service.createJob({
      workspaceId: "alpha",
      prompt: "Long-running job",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      schedule: { kind: "every", every: "1h" },
    });
    const pending = (service as unknown as { triggerJob(jobId: string): Promise<void> }).triggerJob(
      job.id,
    );
    await vi.waitFor(() =>
      expect(service.listRecentRunLogs("alpha")[0]).toMatchObject({
        status: "running",
        sessionPath: "/tmp/interrupted.jsonl",
      }),
    );

    const restarted = new CronService(config);
    await restarted.initialize();
    expect(restarted.listRecentRunLogs("alpha")[0]).toMatchObject({
      status: "error",
      sessionId: "interrupted-session",
      sessionPath: "/tmp/interrupted.jsonl",
      error: "Batty stopped before this cron run completed",
    });

    result.resolve({ sessionId: "interrupted-session", sessionPath: "/tmp/interrupted.jsonl" });
    await pending;
    await restarted.dispose();
    await service.dispose();
  });

  it("keeps an overlapped run registered until its runner settles", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = new CronService(await createConfig());
    const result = deferred<{ sessionId: string; sessionPath: string }>();
    let runSignal: AbortSignal | undefined;
    const run = vi.fn(async (_job, context: { signal: AbortSignal }) => {
      runSignal = context.signal;
      return result.promise;
    });
    service.setRunner({ run });
    const job = await service.createJob({
      workspaceId: "alpha",
      prompt: "Long-running job",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      schedule: { kind: "every", every: "1h" },
    });
    const trigger = (
      service as unknown as { triggerJob(jobId: string): Promise<void> }
    ).triggerJob.bind(service);

    const firstRun = trigger(job.id);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await trigger(job.id);

    expect(runSignal?.aborted).toBe(true);
    expect(service.listRunningJobs()).toHaveLength(1);
    expect(service.listRecentRunLogs("alpha")).toEqual([
      expect.objectContaining({ status: "running", jobId: job.id }),
      expect.objectContaining({
        status: "error",
        jobId: job.id,
        error: expect.stringContaining("skipped"),
      }),
    ]);
    await trigger(job.id);
    expect(run).toHaveBeenCalledTimes(1);

    result.resolve({ sessionId: "result-session", sessionPath: "/tmp/result.jsonl" });
    await firstRun;

    expect(service.listRunningJobs()).toHaveLength(0);
    expect(service.listJobs()[0]?.state.lastStatus).toBe("error");
    const recentLogs = service.listRecentRunLogs("alpha");
    expect(recentLogs).toHaveLength(3);
    expect(recentLogs.slice(0, 2)).toEqual([
      expect.objectContaining({
        status: "error",
        jobId: job.id,
        error: expect.stringContaining("skipped"),
      }),
      expect.objectContaining({
        status: "error",
        jobId: job.id,
        error: expect.stringContaining("skipped"),
      }),
    ]);
    expect(recentLogs[2]).toMatchObject({
      status: "error",
      jobId: job.id,
      error: "Cron run cancelled because a newer run started",
    });
    await service.dispose();
  });
});
