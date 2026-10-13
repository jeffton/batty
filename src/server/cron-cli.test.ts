import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { parseCronArgs, runCronCli } from "./cron-cli";
import { loadConfig } from "./config";

test("wake workout preserves prompt, model, workspace and detached context", async () => {
  const { body } = await parseCronArgs([
    "cron",
    "add",
    "--workspace",
    "roy",
    "--prompt",
    "David's activity\npt.md",
    "--model",
    "openai-codex/gpt-6.1-sol",
    "--thinking",
    "medium",
    "--in",
    "3m",
    "--session",
    "daily-detached",
    "--daily-context",
    "chat-only",
  ]);
  expect(body).toEqual({
    action: "add",
    workspaceId: "roy",
    prompt: "David's activity\npt.md",
    model: "openai-codex/gpt-6.1-sol",
    thinkingLevel: "medium",
    schedule: { kind: "at", in: "3m" },
    session: { kind: "daily-detached", includePreviousContext: "chat-only" },
  });
});

test("disabled updates and log requests are typed", async () => {
  expect((await parseCronArgs(["cron", "update", "id", "--enabled", "false"])).body).toEqual({
    action: "update",
    jobId: "id",
    enabled: false,
  });
  expect((await parseCronArgs(["cron", "list-run-logs", "--limit", "10"])).body.limit).toBe(10);
});

test.each([
  ["0.0.0.0", "127.0.0.1"],
  ["::", "[::1]"],
  ["127.0.0.1", "127.0.0.1"],
  ["::1", "[::1]"],
])("cron CLI contacts loopback for stored listener %s", async (listener, target) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-cron-cli-"));
  const originalHost = process.env.BATTY_HOST;
  const originalPort = process.env.BATTY_PORT;
  const fetch = vi.fn().mockResolvedValue(new Response("[]"));
  vi.stubGlobal("fetch", fetch);
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await fs.mkdir(path.join(root, ".batty"));
    await fs.writeFile(
      path.join(root, ".batty", "options.json"),
      JSON.stringify({ workspacesRoots: [root], webPushSubject: "mailto:test@example.com" }),
    );
    await fs.writeFile(
      path.join(root, ".batty", "environment.json"),
      JSON.stringify({ BATTY_HOST: listener, BATTY_PORT: "4555" }),
    );
    // Stored settings override the deployment wrapper's environment.
    process.env.BATTY_HOST = "localhost";
    process.env.BATTY_PORT = "3147";
    await runCronCli(["--root", root, "cron", "list"]);
    expect(fetch).toHaveBeenCalledWith(
      `http://${target}:4555/api/cron`,
      expect.objectContaining({ method: "POST", body: '{"action":"list"}' }),
    );
    expect((await loadConfig(root)).host).toBe(listener);
  } finally {
    output.mockRestore();
    vi.unstubAllGlobals();
    if (originalHost === undefined) delete process.env.BATTY_HOST;
    else process.env.BATTY_HOST = originalHost;
    if (originalPort === undefined) delete process.env.BATTY_PORT;
    else process.env.BATTY_PORT = originalPort;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ambiguous schedules and malformed flags fail before contacting service", async () => {
  await expect(parseCronArgs(["cron", "add", "--in", "3m", "--every", "5m"])).rejects.toThrow(
    "one schedule",
  );
  await expect(parseCronArgs(["cron", "add", "--enabled", "no"])).rejects.toThrow("true or false");
  await expect(parseCronArgs(["cron", "add", "--daily-context", "false"])).rejects.toThrow(
    "requires --session",
  );
  await expect(parseCronArgs(["cron", "list", "--unknown"])).rejects.toThrow();
});
