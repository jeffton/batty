import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../src/server/config";
import { createAuthToken } from "../src/server/auth";

const root = process.cwd();
const port = 6148;
const baseUrl = `http://127.0.0.1:${port}`;
const workspacePath = path.join(root, "..", "roy");
const sourceOptionsPath = "/var/lib/batty2/.batty/options.json";
const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty2-runtime-smoke-"));
const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty2-runtime-logs-"));
const logPath = path.join(logsDir, "server.log");
let server: ChildProcess | undefined;
let cookieHeader = "";

function log(message: string): void {
  console.log(message);
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${url}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      cookie: cookieHeader,
      ...init.headers,
    },
  });
  const body = await response.text();
  assert(response.ok, `${init.method ?? "GET"} ${url} returned ${response.status}: ${body}`);
  return body ? (JSON.parse(body) as T) : ({} as T);
}

async function startServer(): Promise<ChildProcess> {
  const logFile = await fs.open(logPath, "a", 0o600);
  const child = spawn(process.execPath, [path.join(root, "dist/server/main.mjs"), stateDir], {
    cwd: root,
    env: {
      ...process.env,
      BATTY_PORT: String(port),
      BATTY_PROVIDER_AUTH_PATH: "/root/github/.batty/auth.json",
      BATTY_SELF_PATH: root,
    },
    stdio: ["ignore", logFile.fd, logFile.fd],
  });
  await logFile.close();
  child.on("error", (error) => console.error("Server process error:", error.message));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited during startup (code ${child.exitCode}); see ${logPath}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return child;
    } catch {
      // Listener is not ready yet.
    }
    await delay(200);
  }
  throw new Error(`Server did not become healthy; see ${logPath}`);
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Server failed to stop; see ${logPath}`)),
      12_000,
    );
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitFor<T>(
  description: string,
  predicate: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== undefined) return value;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const cleanup = async () => {
  if (server) await stopServer(server).catch(() => server?.kill("SIGKILL"));
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.rm(logsDir, { recursive: true, force: true });
};

try {
  const source = JSON.parse(await fs.readFile(sourceOptionsPath, "utf8")) as Record<
    string,
    unknown
  >;
  const options = {
    webPushSubject: source.webPushSubject,
    baseUrl: "/",
    appTitle: "Batty smoke",
    appColor: "neutral",
    authSecret: cryptoRandomSecret(),
    workspacesRoots: [path.dirname(workspacePath)],
    pinnedWorkspaceIds: [],
    assistantWorkspaceId: "roy",
    mainWorkspaceId: "roy",
    defaultProvider: "openai-codex",
    defaultModel: "gpt-6-luna",
    defaultThinkingLevel: "low",
  };
  await fs.mkdir(path.join(stateDir, ".batty"), { recursive: true });
  await fs.writeFile(
    path.join(stateDir, ".batty/options.json"),
    `${JSON.stringify(options, null, 2)}\n`,
    { mode: 0o600 },
  );

  const config = await loadConfig(stateDir);
  const token = createAuthToken(config.authSecret);
  cookieHeader = `${config.cookieName}=${token}`;

  server = await startServer();
  const health = await request<{ ok: boolean; mainSessionId: string }>("/healthz");
  assert.equal(health.ok, true);
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200, "main page loads over HTTP");
  assert.match(await page.text(), /<html/i, "main page returns HTML");
  const bootstrap = await request<{
    authenticated: boolean;
    workspaces: { id: string }[];
    settings: { defaultModel?: string; defaultThinkingLevel?: string };
  }>("/api/bootstrap");
  assert.equal(bootstrap.authenticated, true);
  assert.equal(bootstrap.settings.defaultModel, "gpt-6-luna");
  assert.equal(bootstrap.settings.defaultThinkingLevel, "low");
  assert(
    bootstrap.workspaces.some((workspace) => workspace.id === "roy"),
    "roy workspace is listed",
  );
  const initial = await request<SessionState>("/api/main");
  assert.equal(initial.workspaceId, "roy");

  const models = await request<ModelInfo[]>("/api/models");
  const selected = models.find((model) => model.id === "openai-codex/gpt-6-luna");
  assert(
    selected,
    `configured openai-codex/gpt-6-luna model is available; models returned: ${models.map((model) => `${model.provider}/${model.id}`).join(", ")}`,
  );
  if (initial.model !== selected.id && initial.model !== `${selected.provider}/${selected.id}`) {
    const configured = await request<SessionState>("/api/main/model", {
      method: "PATCH",
      body: JSON.stringify({ model: selected.id }),
    });
    assert(configured.model?.includes(selected.id), "main model can be set before prompt");
  }

  const clientMessageId = cryptoRandomSecret();
  await request("/api/main/prompt", {
    method: "POST",
    body: JSON.stringify({
      clientMessageId,
      text: "Use bash to run sleep 8; printf durable-main-ok then respond exactly durable-main-ok.",
    }),
  });
  await waitFor(
    "running bash tool",
    async () => {
      const state = await request<SessionState>("/api/main");
      const bash = state.activeTools.find((tool) => tool.toolName === "bash");
      return state.isStreaming && bash ? bash : undefined;
    },
    45_000,
  );
  log("Observed the real main-session bash process running; restarting the server.");
  await stopServer(server);
  server = undefined;

  server = await startServer();
  const finalState = await waitFor(
    "completed durable main turn",
    async () => {
      const state = await request<SessionState>("/api/main");
      const assistantText = state.messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
      return !state.isStreaming && assistantText.includes("durable-main-ok") ? state : undefined;
    },
    75_000,
  );
  const history = await request<{ messages: UiMessage[] }>("/api/main/messages?limit=100");
  const messages = history.messages;
  const canonicalUserMessages = messages.filter(
    (message) =>
      message.role === "user" &&
      message.blocks.some(
        (block) => block.type === "text" && block.text?.includes("sleep 8; printf durable-main-ok"),
      ),
  );
  assert.equal(
    canonicalUserMessages.length,
    1,
    "prompt is represented by one canonical user message",
  );
  const assistantToolCalls = messages.flatMap((message) =>
    message.role === "assistant"
      ? message.blocks.filter((block) => block.type === "toolCall" && block.name === "bash")
      : [],
  );
  assert.equal(assistantToolCalls.length, 1, "bash was called exactly once");
  const bashResults = messages.filter(
    (message) => message.role === "toolResult" && message.toolName === "bash",
  );
  assert.equal(bashResults.length, 1, "one saved bash result is present");
  assert(
    JSON.stringify(bashResults[0]).includes("durable-main-ok"),
    "saved bash result has command output",
  );
  assert.equal(finalState.isStreaming, false);
  assert.equal(
    finalState.model?.includes("gpt-6-luna"),
    true,
    "selected model persisted across restart",
  );

  const receipts: { status: string; identity: string }[] = [];
  const findReceipts = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await findReceipts(file);
      else if (entry.name === "receipt.json") {
        receipts.push(
          JSON.parse(await fs.readFile(file, "utf8")) as { status: string; identity: string },
        );
      }
    }
  };
  await findReceipts(stateDir);
  assert.equal(receipts.length, 1, "exactly one durable bash job receipt exists");
  assert.equal(receipts[0]?.status, "done");
  log(
    "PASS: authenticated HTTP/API, exactly-once durable bash replay, final response, and model persistence.",
  );
} catch (error) {
  console.error(error);
  console.error(`Private server logs retained at ${logPath}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}

function cryptoRandomSecret(): string {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

type ModelInfo = { id: string; provider: string };
type ToolBlock = { type: string; name?: string; text?: string };
type UiMessage = { role: string; toolName?: string; blocks: ToolBlock[] };
type SessionState = {
  workspaceId: string;
  model?: string;
  isStreaming: boolean;
  activeTools: { toolName: string }[];
  messages: UiMessage[];
};
