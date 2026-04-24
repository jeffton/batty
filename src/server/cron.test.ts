import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { buildCronJobSummary, CronStore } from "./cron";
import type { AppConfig } from "./config";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createConfig(): Promise<AppConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-cron-"));
  tempDirs.push(root);

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
    cookieName: "test",
    authSecret: crypto.randomUUID(),
  };
}

describe("cron store", () => {
  it("defaults jobs to new sessions", async () => {
    const config = await createConfig();
    await fs.mkdir(path.join(config.workspacesRoots[0]!, "alpha"));
    const store = new CronStore(config);

    const job = await store.createJob({
      workspaceId: "alpha",
      prompt: "Morning report",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      schedule: { kind: "every", every: "1h" },
    });

    expect(job.session).toEqual({ kind: "new" });
    expect(buildCronJobSummary(job)).toContain("Session: New per run");
  });

  it("persists daily-inline and daily-subagent cron sessions", async () => {
    const config = await createConfig();
    await fs.mkdir(path.join(config.workspacesRoots[0]!, "alpha"));
    const store = new CronStore(config);

    const inline = await store.createJob({
      workspaceId: "alpha",
      prompt: "Heartbeat",
      model: "openai/gpt-5",
      thinkingLevel: "low",
      session: { kind: "daily-inline" },
      schedule: { kind: "cron", expression: "0 8 * * *" },
    });

    expect(inline.session).toEqual({ kind: "daily-inline" });
    expect(buildCronJobSummary(inline)).toContain("Session: Daily inline");

    const updated = await store.updateJob(inline.id, {
      session: { kind: "daily-subagent", includePreviousContext: true },
    });

    expect(updated.session).toEqual({ kind: "daily-subagent", includePreviousContext: true });
    expect(buildCronJobSummary(updated)).toContain(
      "Session: Daily subagent · with previous context",
    );

    const persisted = JSON.parse(await fs.readFile(store.filePath, "utf8")) as {
      jobs: Array<{ session?: { kind?: string; includePreviousContext?: boolean } }>;
    };
    expect(persisted.jobs[0]?.session).toEqual({
      kind: "daily-subagent",
      includePreviousContext: true,
    });
  });

  it("migrates legacy daily cron sessions to daily-subagent on read", async () => {
    const config = await createConfig();
    await fs.mkdir(path.join(config.workspacesRoots[0]!, "alpha"));
    const store = new CronStore(config);

    await fs.mkdir(path.dirname(store.filePath), { recursive: true });
    await fs.writeFile(
      store.filePath,
      `${JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "legacy-job",
              workspaceId: "alpha",
              prompt: "Legacy job",
              model: "openai/gpt-5",
              thinkingLevel: "medium",
              session: { kind: "daily", includePreviousContext: true },
              createdAt: 1,
              updatedAt: 1,
              schedule: { kind: "every", every: "1h", everyMs: 3600000, anchorAtMs: 1 },
              state: {},
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const [job] = await store.listJobs("alpha");
    expect(job?.session).toEqual({ kind: "daily-subagent", includePreviousContext: true });
    expect(buildCronJobSummary(job!)).toContain("Session: Daily subagent · with previous context");

    const migrated = JSON.parse(await fs.readFile(store.filePath, "utf8")) as {
      version: number;
      jobs: Array<{ session?: { kind?: string; includePreviousContext?: boolean } }>;
    };
    expect(migrated.version).toBe(2);
    expect(migrated.jobs[0]?.session).toEqual({
      kind: "daily-subagent",
      includePreviousContext: true,
    });
  });
});
