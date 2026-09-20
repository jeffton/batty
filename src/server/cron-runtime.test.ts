import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { CronRunLog, PendingCronRunDelivery } from "@/shared/types";
import type { AppConfig } from "./config";
import { CronService } from "./cron-runtime";
import { CronStore } from "./cron-persistence";

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
    sitesDir: path.join(root, "sites"),
    publicDir: path.join(root, "public"),
    webPushDir: path.join(root, "web-push"),
    webPushSubject: "mailto:test@example.com",
    cronDailySessionStartTime: "04:00",
    browserMaxTabs: 16,
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

  it("keeps a completed run active until its delivery queue entry is durable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const config = await createConfig();
    const service = new CronService(config);
    const internals = service as unknown as {
      store: CronStore;
      queueRetryWaiters: Set<{ resolve(): void }>;
      triggerJob(jobId: string): Promise<void>;
    };
    const persistDelivery = vi
      .spyOn(internals.store, "queueRunDelivery")
      .mockRejectedValueOnce(new Error("disk unavailable"));
    service.setRunner({
      run: async (_job, context) => {
        await context.onSessionStarted({
          sessionId: "cron-session",
          sessionPath: "/tmp/cron-session.jsonl",
        });
        await context.queueResultDelivery("parent-session");
        return { sessionId: "cron-session", sessionPath: "/tmp/cron-session.jsonl" };
      },
    });
    const job = await service.createJob({
      workspaceId: "alpha",
      prompt: "Detached work",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      session: { kind: "daily-detached" },
      schedule: { kind: "every", every: "1h" },
    });
    const triggered = internals.triggerJob(job.id);
    await vi.waitFor(() => expect(persistDelivery).toHaveBeenCalledOnce());
    expect(service.listRecentRunLogs()[0]?.status).toBe("running");

    [...internals.queueRetryWaiters][0]!.resolve();
    await triggered;
    expect(persistDelivery).toHaveBeenCalledTimes(2);
    expect(service.listRecentRunLogs()[0]).toMatchObject({
      status: "success",
      pendingDelivery: { parentSessionId: "parent-session" },
    });
    await service.dispose();
  });

  it("retries terminal state persistence before delivering a queued result", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const config = await createConfig();
    const service = new CronService(config);
    const internals = service as unknown as {
      store: CronStore;
      queueRetryWaiters: Set<{ resolve(): void }>;
      triggerJob(jobId: string): Promise<void>;
    };
    const updateRun = internals.store.updateRun.bind(internals.store);
    let failedTerminalWrite = false;
    vi.spyOn(internals.store, "updateRun").mockImplementation((runId, patch) => {
      if (!failedTerminalWrite && patch.status === "success") {
        failedTerminalWrite = true;
        return Promise.reject(new Error("disk unavailable"));
      }
      return updateRun(runId, patch);
    });
    service.setRunner({
      run: async (_job, context) => {
        await context.onSessionStarted({
          sessionId: "cron-session",
          sessionPath: "/tmp/cron-session.jsonl",
        });
        await context.queueResultDelivery("parent-session");
        return { sessionId: "cron-session", sessionPath: "/tmp/cron-session.jsonl" };
      },
    });
    const job = await service.createJob({
      workspaceId: "alpha",
      prompt: "Detached work",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      session: { kind: "daily-detached" },
      schedule: { kind: "every", every: "1h" },
    });
    const triggered = internals.triggerJob(job.id);
    await vi.waitFor(() => expect(internals.queueRetryWaiters.size).toBe(1));
    expect(service.listRecentRunLogs()[0]).toMatchObject({
      status: "running",
      pendingDelivery: { parentSessionId: "parent-session" },
    });

    [...internals.queueRetryWaiters][0]!.resolve();
    await triggered;
    expect(service.listRecentRunLogs()[0]).toMatchObject({
      status: "success",
      pendingDelivery: { parentSessionId: "parent-session" },
    });
    await service.dispose();
  });

  it("persists queued delivery without resuming it after restart", async () => {
    const config = await createConfig();
    const first = new CronService(config);
    const blockedDelivery = deferred<void>();
    const firstDelivery = vi.fn(() => blockedDelivery.promise);
    first.setRunner({
      run: async (_job, context) => {
        await context.onSessionStarted({
          sessionId: "cron-session",
          sessionPath: "/tmp/cron-session.jsonl",
        });
        await context.queueResultDelivery("parent-session");
        return { sessionId: "cron-session", sessionPath: "/tmp/cron-session.jsonl" };
      },
      deliver: firstDelivery,
    });
    const job = await first.createJob({
      workspaceId: "alpha",
      prompt: "Detached work",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      session: { kind: "daily-detached" },
      schedule: { kind: "every", every: "1h" },
    });
    await (first as unknown as { triggerJob(jobId: string): Promise<void> }).triggerJob(job.id);

    expect(first.listRunningJobs()).toHaveLength(0);
    await vi.waitFor(() => expect(firstDelivery).toHaveBeenCalledOnce());
    expect(first.listRecentRunLogs()[0]).toMatchObject({
      status: "success",
      pendingDelivery: { parentSessionId: "parent-session", queuedAtMs: expect.any(Number) },
    });
    await first.dispose();

    const delivered = vi.fn(async () => undefined);
    const restarted = new CronService(config);
    restarted.setRunner({ run: vi.fn(), deliver: delivered });
    await restarted.initialize();
    expect(delivered).not.toHaveBeenCalled();
    expect(restarted.listRecentRunLogs()[0]?.pendingDelivery).toEqual(
      expect.objectContaining({ parentSessionId: "parent-session" }),
    );
    blockedDelivery.resolve(undefined);
    await restarted.dispose();
  });

  it("does not deliver archived queue entries after reloads or a later run completes", async () => {
    const config = await createConfig();
    const store = new CronStore(config);
    await store.startRun({
      runId: "archived-delivery",
      jobId: "deleted-job",
      workspaceId: "alpha",
      prompt: "Archived detached work",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      session: { kind: "daily-detached", includePreviousContext: false },
      scheduleLabel: "Every hour",
      startedAtMs: Date.now() - 1_000,
      status: "success",
      completedAtMs: Date.now() - 500,
      durationMs: 500,
    });
    await store.queueRunDelivery("archived-delivery", "archived-parent");

    const delivered = vi.fn(
      async (_run: CronRunLog, _delivery: PendingCronRunDelivery) => undefined,
    );
    const service = new CronService(config);
    service.setRunner({
      run: async (_job, context) => {
        await context.queueResultDelivery("current-parent");
        return { sessionId: "current-session", sessionPath: "/tmp/current.jsonl" };
      },
      deliver: delivered,
    });
    await service.initialize();
    const job = await service.createJob({
      workspaceId: "alpha",
      prompt: "Current detached work",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      session: { kind: "daily-detached" },
      schedule: { kind: "every", every: "1h" },
    });
    await service.updateJob(job.id, { prompt: "Edited current detached work" });
    expect(delivered).not.toHaveBeenCalled();

    await (service as unknown as { triggerJob(jobId: string): Promise<void> }).triggerJob(job.id);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce());
    expect(delivered.mock.calls[0]?.[0]).not.toMatchObject({ runId: "archived-delivery" });
    expect(
      service.listRecentRunLogs().find((run) => run.runId === "archived-delivery"),
    ).toMatchObject({
      pendingDelivery: { parentSessionId: "archived-parent" },
    });
    await service.dispose();
  });

  it("drains admitted runs and deliveries without admitting new cron work", async () => {
    const service = new CronService(await createConfig());
    const runResult = deferred<{ sessionId: string; sessionPath: string }>();
    const deliveryResult = deferred<void>();
    const run = vi.fn(async (_job, context) => {
      await context.queueResultDelivery("parent-session");
      return runResult.promise;
    });
    const deliver = vi.fn(() => deliveryResult.promise);
    service.setRunner({ run, deliver });
    const job = await service.createJob({
      workspaceId: "alpha",
      prompt: "Drain work",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      session: { kind: "daily-detached" },
      schedule: { kind: "every", every: "1h" },
    });
    const trigger = (service as unknown as { triggerJob(jobId: string): Promise<void> }).triggerJob(
      job.id,
    );
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(service.activeTurns).toBe(1);

    service.beginDrain();
    expect(
      (service as unknown as { scheduledHandles: Map<string, unknown> }).scheduledHandles.size,
    ).toBe(0);
    await (service as unknown as { triggerJob(jobId: string): Promise<void> }).triggerJob(job.id);
    expect(run).toHaveBeenCalledOnce();

    runResult.resolve({ sessionId: "cron-session", sessionPath: "/tmp/cron-session.jsonl" });
    await trigger;
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    expect(service.activeTurns).toBe(1);
    deliveryResult.resolve(undefined);
    await vi.waitFor(() => expect(service.activeTurns).toBe(0));
    await service.dispose();
  });

  it("keeps admitted delivery work active through retries while draining", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const service = new CronService(await createConfig());
      const runResult = deferred<{ sessionId: string; sessionPath: string }>();
      const deliver = vi
        .fn<(run: CronRunLog, delivery: PendingCronRunDelivery) => Promise<void>>()
        .mockRejectedValueOnce(new Error("delivery unavailable"))
        .mockResolvedValueOnce(undefined);
      service.setRunner({
        run: async (_job, context) => {
          await context.queueResultDelivery("parent-session");
          return runResult.promise;
        },
        deliver,
      });
      const job = await service.createJob({
        workspaceId: "alpha",
        prompt: "Drain retry work",
        model: "openai/gpt-5",
        thinkingLevel: "medium",
        session: { kind: "daily-detached" },
        schedule: { kind: "every", every: "1h" },
      });
      const trigger = (
        service as unknown as { triggerJob(jobId: string): Promise<void> }
      ).triggerJob(job.id);
      await vi.waitFor(() => expect(service.activeTurns).toBe(1));
      service.beginDrain();
      runResult.resolve({ sessionId: "cron-session", sessionPath: "/tmp/cron-session.jsonl" });
      await trigger;
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      expect(service.activeTurns).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(service.activeTurns).toBe(0));
      await service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { name: "inline", session: { kind: "daily-inline" as const } },
    {
      name: "detached context snapshot",
      session: { kind: "daily-detached" as const, includePreviousContext: true },
    },
  ])("queues $name runs instead of skipping while the parent is busy", async ({ session }) => {
    const service = new CronService(await createConfig());
    const results = [
      deferred<{ sessionId: string; sessionPath: string }>(),
      deferred<{ sessionId: string; sessionPath: string }>(),
    ];
    const signals: AbortSignal[] = [];
    const run = vi.fn(async (_job, context: { signal: AbortSignal }) => {
      signals.push(context.signal);
      return results[signals.length - 1]!.promise;
    });
    service.setRunner({ run });
    const job = await service.createJob({
      workspaceId: "alpha",
      prompt: "Parent-bound work",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      session,
      schedule: { kind: "every", every: "1h" },
    });
    const trigger = (
      service as unknown as { triggerJob(jobId: string): Promise<void> }
    ).triggerJob.bind(service);

    const first = trigger(job.id);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const second = trigger(job.id);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    expect(service.listRecentRunLogs()).toEqual([
      expect.objectContaining({ status: "running", jobId: job.id }),
      expect.objectContaining({ status: "running", jobId: job.id }),
    ]);

    results[0]!.resolve({ sessionId: "session-1", sessionPath: "/tmp/session-1.jsonl" });
    results[1]!.resolve({ sessionId: "session-2", sessionPath: "/tmp/session-2.jsonl" });
    await Promise.all([first, second]);
    expect(service.listRecentRunLogs().map((log) => log.status)).toEqual(["success", "success"]);
    await service.dispose();
  });

  it("retries a disk reload when a newer run log is installed concurrently", async () => {
    const config = await createConfig();
    const service = new CronService(config);
    const job = await service.createJob({
      workspaceId: "alpha",
      prompt: "Reload race",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      schedule: { kind: "every", every: "1h" },
    });
    const store = new CronStore(config);
    const startedLog: CronRunLog = {
      runId: crypto.randomUUID(),
      jobId: job.id,
      workspaceId: job.workspaceId,
      prompt: job.prompt,
      model: job.model,
      thinkingLevel: job.thinkingLevel,
      session: job.session,
      scheduleLabel: job.scheduleLabel,
      startedAtMs: Date.now(),
      status: "running",
    };
    await store.startRun(startedLog);

    const internals = service as unknown as {
      store: CronStore;
      reloadFromDisk(schedule: boolean): Promise<void>;
      replaceRunLog(run: CronRunLog): void;
    };
    await internals.reloadFromDisk(false);
    const staleSnapshot = await store.readStoredSnapshot();
    const snapshotStarted = deferred<void>();
    const releaseSnapshot = deferred<void>();
    const originalReadSnapshot = internals.store.readStoredSnapshot.bind(internals.store);
    const readSnapshot = vi
      .spyOn(internals.store, "readStoredSnapshot")
      .mockImplementation(originalReadSnapshot)
      .mockImplementationOnce(async () => {
        snapshotStarted.resolve(undefined);
        await releaseSnapshot.promise;
        return staleSnapshot;
      });

    const reload = internals.reloadFromDisk(false);
    await snapshotStarted.promise;
    const completedLog = await store.updateRun(startedLog.runId, {
      status: "success",
      completedAtMs: Date.now(),
      durationMs: 1,
    });
    internals.replaceRunLog(completedLog!);
    releaseSnapshot.resolve(undefined);
    await reload;

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(service.listRecentRunLogs()[0]?.status).toBe("success");
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
