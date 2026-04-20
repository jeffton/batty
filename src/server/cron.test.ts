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
    workspacesRoot: root,
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
    await fs.mkdir(path.join(config.workspacesRoot, "alpha"));
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

  it("defaults daily session mode to fresh context and persists updates", async () => {
    const config = await createConfig();
    await fs.mkdir(path.join(config.workspacesRoot, "alpha"));
    const store = new CronStore(config);

    const created = await store.createJob({
      workspaceId: "alpha",
      prompt: "Heartbeat",
      model: "openai/gpt-5",
      thinkingLevel: "low",
      session: { kind: "daily" },
      schedule: { kind: "cron", expression: "0 8 * * *" },
    });

    expect(created.session).toEqual({ kind: "daily", includePreviousContext: false });
    expect(buildCronJobSummary(created)).toContain("Session: Daily · fresh context");

    const updated = await store.updateJob(created.id, {
      session: { kind: "daily", includePreviousContext: true },
    });

    expect(updated.session).toEqual({ kind: "daily", includePreviousContext: true });
    expect(buildCronJobSummary(updated)).toContain("Session: Daily · with previous context");

    const persisted = JSON.parse(await fs.readFile(store.filePath, "utf8")) as {
      jobs: Array<{ session?: { kind?: string; includePreviousContext?: boolean } }>;
    };
    expect(persisted.jobs[0]?.session).toEqual({ kind: "daily", includePreviousContext: true });
  });
});
