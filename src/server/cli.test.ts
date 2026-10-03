import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { loadConfig } from "./config";
import { CronStore } from "./cron";
import { startDeploymentControl } from "./deployment-control";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const cliPath = path.resolve("src/server/cli.ts");
const tsxPath = path.resolve("node_modules/.bin/tsx");

async function createRoot(options = true): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-cli-"));
  tempDirs.push(root);
  await fs.mkdir(path.join(root, ".batty"), { recursive: true });
  await fs.mkdir(path.join(root, "batty"));
  if (options) {
    await fs.writeFile(
      path.join(root, ".batty", "options.json"),
      JSON.stringify({ workspacesRoots: [root], webPushSubject: "mailto:test@example.com" }),
    );
  }
  return root;
}

async function runCli(root: string, args: string[]): Promise<{ code: number; output: string }> {
  try {
    const result = await execFileAsync(tsxPath, [cliPath, "--root", root, ...args]);
    return { code: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const result = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      code: result.code ?? 1,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("deployment CLI", () => {
  it("shows help without configuration and rejects unknown commands", async () => {
    const root = await createRoot(false);
    const help = await runCli(root, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.output).toContain("drain");

    const result = await runCli(root, ["unknown-command"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Unknown command: unknown-command");
  });

  it("checkpoints without loading configuration or waiting for unrelated work", async () => {
    const root = await createRoot(false);
    let drained = false;
    const control = await startDeploymentControl(root, async () => {
      drained = true;
    });

    try {
      const drain = await runCli(root, ["drain"]);
      expect(drain).toMatchObject({ code: 0 });
      expect(drain.output).toContain("Durable sessions checkpointed.");
      expect(drained).toBe(true);
    } finally {
      await control.close();
    }
  });
});

describe("checkpoint CLI identity", () => {
  it("passes the deploying session path verbatim", async () => {
    const root = await createRoot(false);
    const sessionPath = path.join(root, "session with spaces.sqlite");
    let received: [string | undefined, string | undefined] | undefined;
    const control = await startDeploymentControl(root, async (value, afterEntryId) => {
      received = [value, afterEntryId];
    });
    try {
      expect(
        await runCli(root, ["drain", "--session", sessionPath, "--after-entry", "tool-use-entry"]),
      ).toMatchObject({ code: 0 });
      expect(received).toEqual([sessionPath, "tool-use-entry"]);
    } finally {
      await control.close();
    }
  });

  it.each([
    ["--session", "/session.sqlite"],
    ["--after-entry", "entry"],
    ["--session", "/session.sqlite", "--after-entry"],
  ])("rejects incomplete response identity %s", async (...args) => {
    const root = await createRoot(false);
    expect(await runCli(root, ["drain", ...args])).toMatchObject({ code: 1 });
  });

  it("rejects a missing session path", async () => {
    const root = await createRoot(false);
    expect(await runCli(root, ["drain", "--session"])).toMatchObject({ code: 1 });
  });
});

describe("cron CLI model validation", () => {
  it("rejects an unknown model before creating a job", async () => {
    const root = await createRoot();
    const result = await runCli(root, [
      "cron",
      "add",
      "--workspace",
      "batty",
      "--prompt",
      "Inspect CI",
      "--model",
      "missing/model",
      "--thinking",
      "medium",
      "--in",
      "1h",
    ]);

    expect(result).toMatchObject({ code: 1 });
    expect(result.output).toContain("Model not found: missing/model");
    const store = new CronStore(await loadConfig(root));
    expect(await store.listJobs()).toEqual([]);
  });

  it("rejects an unknown replacement model before editing a job", async () => {
    const root = await createRoot();
    const store = new CronStore(await loadConfig(root));
    const job = await store.createJob({
      workspaceId: "batty",
      prompt: "Inspect CI",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      schedule: { kind: "every", every: "1h" },
    });

    const result = await runCli(root, ["cron", "edit", job.id, "--model", "missing/model"]);

    expect(result).toMatchObject({ code: 1 });
    expect(result.output).toContain("Model not found: missing/model");
    expect((await store.listJobs())[0]?.model).toBe("openai/gpt-5");
  });
});
