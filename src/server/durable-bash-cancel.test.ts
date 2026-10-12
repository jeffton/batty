// @vitest-environment node
import { expect, test } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { persistentBashOperations } from "./durable-bash";
import {
  bashJobKey,
  cancelPersistentBashJob,
  cancelPersistentBashJobs,
} from "./durable-bash-cancel";

async function until(file: string) {
  for (let i = 0; i < 200; i++) {
    try {
      await fs.access(file);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${file}`);
}

test("cancel before bash launch leaves no claim and produces terminal exit 130", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-cancel-before-"));
  try {
    await cancelPersistentBashJob(root, "1-2-call");
    const result = await persistentBashOperations(root, "1-2-call").exec(
      "echo ran > marker",
      root,
      { onData: () => {} },
    );
    expect(result.exitCode).toBe(130);
    await expect(fs.access(path.join(root, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 5000);

test("conversation cancellation handshakes through a pending supervisor startup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-cancel-starting-"));
  try {
    const job = persistentBashOperations(root, "7-8-call").exec(
      "sleep 2; echo ran > marker",
      root,
      { onData: () => {} },
    );
    await until(path.join(root, bashJobKey("7-8-call"), "intent.json"));
    await cancelPersistentBashJobs(root, 7);
    expect((await job).exitCode).toBe(130);
    await expect(fs.access(path.join(root, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 5000);

test("bash cancellation escalates SIGTERM-ignoring process groups to SIGKILL", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-cancel-escalate-"));
  try {
    const job = persistentBashOperations(root, "9-10-call").exec(
      "trap '' TERM; echo ready > started; sleep 3; echo survived > marker",
      root,
      { onData: () => {} },
    );
    await until(path.join(root, "started"));
    const began = Date.now();
    await cancelPersistentBashJob(root, "9-10-call");
    expect(Date.now() - began).toBeLessThan(process.platform === "win32" ? 5000 : 1500);
    expect((await job).exitCode).toBe(130);
    await expect(fs.access(path.join(root, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 5000);
