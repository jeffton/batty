import fs from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import type { OwnerInputs } from "../shared/owner-api";
import { RpcError, type RpcContext, type RpcHandler, type RpcReply } from "../shared/rpc-channel";
import type { AppSettingsStatus } from "../shared/types";
import { isSubscriptionProvider } from "../shared/provider-auth";
import { Runtime, context } from "./runtime";
import type { TranscriptImages } from "./transcript-images";
import type { WebPushService } from "./web-push";
import type { PasskeyAuthService } from "./passkeys";
import { readEnvironmentFile, updateEnvironmentFile } from "./config";
import {
  stateDirPath,
  setAppearance,
  setBraveSearchKey,
  setDefaultModel,
  setMemoryLanguage,
  setMemoryModel,
  setPushTitle,
} from "./options";
import { listWorkspaces } from "./workspaces";
import { changeAssistantWorkspace } from "./assistant-settings";
import { workspaceBrowserKey } from "./browser-service";
import { CloudBrowserControlSchema } from "./browser-schemas";
import { CloudBrowserCredentialsSchema } from "./cloud-browser-credentials-schema";
import { setSitePublic } from "./sites";
import { executeSiteFunction } from "./site-functions";
import type { BrowserErrorReport } from "../shared/browser-errors";
import type { CronJob, CronRun } from "./orchestration";
import { cronCommand } from "./routes/cron";
import { repairMemory } from "./memory-api";
import type { Schedule } from "./orchestration-state";
import { workspaceGit, workspaceFiles, workspaceSearch } from "./routes/workspace-files";
import { assistantAgentsRead, assistantAgentsWrite } from "./routes/assistant-agents";
import { createSessionOperations } from "./session-api";

export interface OwnerRpcServices {
  transcriptImages: TranscriptImages;
  webPush: WebPushService;
  passkeys: PasskeyAuthService;
  settingsStatus: () => AppSettingsStatus;
  buildId: string;
  browserAvailable: boolean;
  logSubmission?: (correlationId: string) => void;
  reportBrowserError?: (report: BrowserErrorReport) => Promise<void>;
  remoteOperation?: (operation: string, input: unknown) => Promise<unknown>;
}

function badInput(message: string): never {
  throw new RpcError("BAD_INPUT", message);
}
function requireName(name: string) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name))
    badInput("Invalid MCP server name");
}
export function scheduleLabel(schedule: Schedule): string {
  if (schedule.kind === "multiple") return schedule.triggers.map(scheduleLabel).join(" · ");
  return schedule.kind === "at"
    ? `At ${schedule.at}`
    : schedule.kind === "every"
      ? `Every ${schedule.every}`
      : `${schedule.expression} (${schedule.timezone})`;
}
function cronRunLog(runtime: Runtime, run: CronRun, jobs: CronJob[]) {
  const config = runtime.config;
  const job = jobs.find((item) => item.id === run.jobId) ?? run.job;
  return {
    runId: run.id,
    jobId: run.jobId,
    workspaceId: run.workspaceId,
    prompt: job?.prompt ?? "",
    model: job?.model ?? `${config.defaultProvider}/${config.defaultModel}`,
    thinkingLevel: job?.thinkingLevel ?? config.defaultThinkingLevel,
    scheduleLabel: job ? scheduleLabel(job.schedule) : "",
    startedAtMs: run.startedAt,
    sessionId: run.sessionId,
    sessionPath: `durable:${run.sessionId}`,
    status: run.status === "running" ? "running" : run.status === "completed" ? "success" : "error",
    completedAtMs: run.finishedAt,
    durationMs: run.finishedAt ? run.finishedAt - run.startedAt : undefined,
    error: run.status === "failed" ? run.output : undefined,
  };
}

/** Explicit owner API. Authorization belongs to the authenticated socket boundary. */
export function createOwnerRpcHandler(runtime: Runtime, services: OwnerRpcServices): RpcHandler {
  const { config } = runtime;
  const { webPush, passkeys, settingsStatus } = services;
  const operations = new Map<string, (input: unknown, rpc: RpcContext) => Promise<RpcReply>>();
  function add<K extends keyof OwnerInputs>(
    name: K,
    run: (input: OwnerInputs[K], rpc: RpcContext) => unknown | Promise<unknown>,
  ) {
    operations.set(name, async (input, rpc) => ({
      value: await run(input as OwnerInputs[K], rpc),
    }));
  }
  function streaming<K extends keyof OwnerInputs>(
    name: K,
    run: (input: OwnerInputs[K], rpc: RpcContext) => RpcReply | Promise<RpcReply>,
  ) {
    operations.set(name, (input, rpc) => Promise.resolve(run(input as OwnerInputs[K], rpc)));
  }
  for (const [name, operation] of createSessionOperations(runtime, services))
    operations.set(name, operation);
  add("workspace.list", async () => ({ workspaces: await listWorkspaces(config, true) }));
  add("workspace.git", ({ workspaceId }) => workspaceGit(config, workspaceId));
  add("workspace.files", ({ workspaceId, path }) => workspaceFiles(config, workspaceId, path));
  add("workspace.file", ({ workspaceId, path }) => workspaceFiles(config, workspaceId, path));
  streaming("workspace.search", ({ workspaceId, name }, rpc) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    rpc.signal.addEventListener("abort", abort, { once: true });
    if (rpc.signal.aborted) abort();
    const matches = workspaceSearch(config, workspaceId, name, controller.signal);
    let done = false;
    return {
      value: {},
      events: new ReadableStream(
        {
          async pull(stream) {
            if (done) {
              stream.close();
              return;
            }
            try {
              const next = await matches.next();
              if (next.done) {
                done = true;
                rpc.signal.removeEventListener("abort", abort);
                stream.enqueue({ kind: "done" });
              } else stream.enqueue({ kind: "match", path: next.value });
            } catch (error) {
              done = true;
              rpc.signal.removeEventListener("abort", abort);
              stream.enqueue({ kind: "error", message: (error as Error).message });
            }
          },
          async cancel() {
            abort();
            rpc.signal.removeEventListener("abort", abort);
            await matches.return(undefined);
          },
        },
        { highWaterMark: 0 },
      ),
    };
  });
  add("assistant-agents.get", ({ workspaceId }) => assistantAgentsRead(config, workspaceId));
  add("assistant-agents.set", ({ workspaceId, content }) =>
    assistantAgentsWrite(config, workspaceId, content),
  );
  add("diagnostics.report", async ({ report }) => {
    await services.reportBrowserError!(report);
    return {};
  });
  for (const operation of [
    "remotes.get",
    "remotes.token.generate",
    "remotes.token.revoke",
    "remotes.connection.add",
    "remotes.connection.remove",
  ] as const)
    add(operation, (input) => services.remoteOperation!(operation, input));
  add("models.list", () => runtime.listModels());
  add("memory.tree", () => runtime.memory.browserOverview());
  add("memory.expand", ({ id, count }) => runtime.memory.browserNode(id, count));
  add("memory.status", () => runtime.memory.status());
  add("memory.usage", () => runtime.memory.usage());
  add("memory.repair", (input) => repairMemory(runtime.memory, input));
  add("cron.command", (input) => cronCommand(runtime.orchestration, input));
  add("cron.running", async () => {
    const [runs, jobs] = await Promise.all([
      runtime.orchestration.listRunningCron(),
      runtime.orchestration.listJobs(),
    ]);
    return runs.map((run) => cronRunLog(runtime, run, jobs));
  });
  add("workspace.cron.jobs", async ({ workspaceId }) =>
    (await runtime.orchestration.listJobs(workspaceId)).map((job) => ({
      ...job,
      model: job.model ?? `${config.defaultProvider}/${config.defaultModel}`,
      thinkingLevel: job.thinkingLevel ?? config.defaultThinkingLevel,
      scheduleLabel: scheduleLabel(job.schedule),
      state: { nextRunAtMs: job.nextAt },
    })),
  );
  add("workspace.cron.logs", async ({ workspaceId }) => {
    const jobs = await runtime.orchestration.listJobs();
    return (await runtime.orchestration.listRunLogs(undefined, 100, workspaceId)).map((run) =>
      cronRunLog(runtime, run, jobs),
    );
  });
  add("provider.status", () => runtime.providerAuth.getStatus());
  add("provider.usage", ({ provider, model }) => runtime.providerUsage.getUsage(provider, model));
  add("provider.start", ({ providerId }) => {
    if (!isSubscriptionProvider(providerId)) badInput("Unsupported subscription provider");
    return runtime.providerAuth.start(providerId);
  });
  add("provider.attempt", ({ attemptId }) => runtime.providerAuth.getAttemptStatus(attemptId));
  add("provider.complete", async ({ attemptId, callbackUrl }) => {
    await runtime.providerAuth.complete(attemptId, callbackUrl);
    return runtime.providerAuth.getStatus();
  });
  add("provider.key", ({ providerId, apiKey }) => {
    if (providerId !== "google" && providerId !== "openrouter")
      badInput("Unsupported API-key provider");
    return runtime.providerAuth.setApiKey(providerId, apiKey);
  });
  add("provider.logout", async ({ providerId }) => {
    await runtime.models.logout(providerId);
    return runtime.providerAuth.getStatus();
  });
  add("settings.assistant-workspace", ({ workspaceId }) =>
    changeAssistantWorkspace(config, workspaceId, {
      state: () => runtime.state("main", undefined, false),
      configure: (cwd) => runtime.main.configure({ cwd }, context),
    }),
  );
  add("settings.brave-search", async ({ apiKey }) => {
    config.braveSearchKey = (await setBraveSearchKey(config.battyDir, apiKey)).braveSearchKey;
    return settingsStatus();
  });
  add("settings.appearance", async ({ title, color }) => {
    const settings = await setAppearance(config.battyDir, title, color);
    config.appTitle = settings.appTitle;
    config.appColor = settings.appColor;
    return settingsStatus();
  });
  add("settings.default-model", async ({ modelId, thinkingLevel }) => {
    const slash = modelId.indexOf("/");
    const settings = await setDefaultModel(
      config.battyDir,
      modelId.slice(0, slash),
      modelId.slice(slash + 1),
      thinkingLevel,
    );
    Object.assign(config, {
      defaultProvider: settings.defaultProvider,
      defaultModel: settings.defaultModel,
      defaultThinkingLevel: settings.defaultThinkingLevel,
    });
    return settingsStatus();
  });
  add("settings.memory-language", async ({ language }) => {
    if (!language.trim()) badInput("Enter a memory language");
    config.memoryLanguage = (
      await setMemoryLanguage(config.battyDir, language.trim())
    ).memoryLanguage;
    return settingsStatus();
  });
  add("settings.memory-model", async ({ modelId }) => {
    config.memoryModel = (await setMemoryModel(config.battyDir, modelId)).memoryModel;
    return settingsStatus();
  });
  add("settings.push-title", async ({ title }) => {
    if (!title.trim()) badInput("Enter a push title");
    config.pushTitle = (await setPushTitle(config.battyDir, title.trim())).pushTitle;
    return settingsStatus();
  });
  add("settings.copy-value", async ({ kind, name }) => {
    if (!["provider", "environment", "brave-search"].includes(kind) || typeof name !== "string")
      badInput("Invalid setting");
    const env = kind === "environment" ? await readEnvironmentFile(config.battyDir) : undefined;
    const value =
      kind === "provider"
        ? await runtime.providerAuth.getApiKey(name)
        : kind === "brave-search"
          ? config.braveSearchKey || undefined
          : Object.hasOwn(env!, name)
            ? env![name]
            : undefined;
    if (value === undefined) throw new RpcError("NOT_FOUND", "Saved value not found");
    return { value };
  });
  add("environment.list", async () => ({
    names: Object.keys(await readEnvironmentFile(config.battyDir)).sort(),
  }));
  add("environment.set", async ({ name, value }) => ({
    names: await updateEnvironmentFile(config.battyDir, name, value),
  }));
  add("environment.remove", async ({ name }) => ({
    names: await updateEnvironmentFile(config.battyDir, name),
  }));
  add("agents.get", async () => ({
    content: await fs.readFile(path.join(stateDirPath(config.battyDir), "AGENTS.md"), "utf8"),
  }));
  add("agents.set", async ({ content }) => {
    await fs.writeFile(path.join(stateDirPath(config.battyDir), "AGENTS.md"), content);
    return { content };
  });
  const mcp = runtime.tools.mcp;
  const globalMcpInput = (input: object, allowed: string[]) => {
    if (Object.keys(input).some((key) => !allowed.includes(key)))
      badInput("MCP settings are global");
  };
  add("mcp.settings", (input) => {
    globalMcpInput(input, []);
    return mcp.readSettings();
  });
  add("mcp.set", (input) => {
    globalMcpInput(input, ["name", "config"]);
    const { name, config: serverConfig } = input;
    requireName(name);
    if (!serverConfig || typeof serverConfig !== "object" || Array.isArray(serverConfig))
      badInput("MCP server config must be an object");
    return mcp.setServer(name, serverConfig);
  });
  add("mcp.remove", (input) => {
    globalMcpInput(input, ["name"]);
    requireName(input.name);
    return mcp.removeServer(input.name);
  });
  add("mcp.status", () => mcp.getStatus());
  add("mcp.reconnect", ({ name }) => {
    requireName(name);
    return mcp.reconnect(name);
  });
  add("mcp.logout", ({ name }) => {
    requireName(name);
    return mcp.logout(name);
  });
  add("mcp.login", ({ name }) => {
    requireName(name);
    return mcp.startAuth(name);
  });
  add("mcp.attempt", ({ attemptId }) => mcp.getAuthAttempt(attemptId));
  add("mcp.complete", ({ attemptId, callbackUrl }) => {
    if (typeof callbackUrl !== "string" || !callbackUrl)
      badInput("callbackUrl must be a non-empty string");
    return mcp.completeAuth(attemptId, callbackUrl);
  });
  add("mcp.cancel", ({ attemptId }) => mcp.cancelAuth(attemptId));
  add("push.key", () => ({ publicKey: webPush.getPublicKey() }));
  add("push.save", async ({ subscription }) => {
    await webPush.upsertSubscription(subscription);
    return { ok: true };
  });
  add("push.delete", async ({ endpoint }) => {
    await webPush.removeSubscription(endpoint);
    return { ok: true };
  });
  add("push.ack", ({ clientId, challengeId }) => ({
    ok: webPush.foreground.acknowledge(clientId, challengeId),
  }));
  add("site.public", ({ siteId, public: isPublic }) => {
    if (typeof isPublic !== "boolean") badInput("public must be a boolean");
    return setSitePublic(config.sitesDir, config.baseUrl, siteId, isPublic);
  });
  add("site.call", ({ siteId, name, input }) =>
    executeSiteFunction(config.sitesDir, siteId, name, input),
  );
  const browser = runtime.tools.browserService;
  add("browser.open", async ({ workspaceId }) => {
    if (!services.browserAvailable)
      throw new RpcError("UNAVAILABLE", "Cloud browser is unavailable on this host.");
    if (!(await listWorkspaces(config)).some((workspace) => workspace.id === workspaceId))
      throw new RpcError("NOT_FOUND", "Workspace not found.");
    return browser.openCloudBrowser(workspaceBrowserKey(workspaceId));
  });
  add("browser.state", ({ browserId }) => browser.cloudState(browserId));
  add("browser.control", ({ browserId, control }) => {
    if (!Check(CloudBrowserControlSchema, control)) badInput("Invalid browser control command.");
    return browser.cloudControl(browserId, control);
  });
  add("browser.credentials.prepare", ({ browserId }) => browser.prepareCloudCredentials(browserId));
  add("browser.credentials.fill", async ({ browserId, credentials }) => {
    if (!Check(CloudBrowserCredentialsSchema, credentials)) badInput("Invalid credential request.");
    try {
      await browser.fillCloudCredentials(browserId, credentials);
    } catch (error) {
      const failure = error as Error & { statusCode?: number };
      throw Object.assign(
        new Error("Credential fill failed. Reopen the login panel and try again."),
        { statusCode: failure.statusCode },
      );
    }
    return {};
  });
  add("auth.status", () => passkeys.getStatus());
  add("auth.setup-code", () => passkeys.issueSetupCode("settings"));
  return async (operation, input, rpc) => {
    const handler = operations.get(operation);
    if (!handler) throw new RpcError("NOT_FOUND", `Unknown owner operation: ${operation}`);
    if (!input || typeof input !== "object" || Array.isArray(input))
      badInput("Operation input must be an object");
    rpc.signal.throwIfAborted();
    try {
      return await handler(input, rpc);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      const failure = error as Error & { statusCode?: number; pages?: unknown };
      const code = failure.pages
        ? "SELECTION_CHANGED"
        : ((
            {
              400: "BAD_INPUT",
              401: "UNAUTHORIZED",
              403: "FORBIDDEN",
              404: "NOT_FOUND",
              409: "CONFLICT",
              410: "GONE",
              429: "RATE_LIMITED",
              501: "UNAVAILABLE",
              503: "OFFLINE",
              504: "TIMEOUT",
            } as Record<number, string>
          )[failure.statusCode ?? 500] ?? (error instanceof RangeError ? "BAD_INPUT" : "INTERNAL"));
      throw new RpcError(
        code,
        failure.message,
        failure.pages ? { pages: failure.pages } : undefined,
      );
    }
  };
}
