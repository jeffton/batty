import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { loadConfig, resolveBattyDir, readEnvironmentFile, updateEnvironmentFile } from "./config";
import {
  stateDirPath,
  setAppearance,
  setPushTitle,
  setBraveSearchKey,
  setDefaultModel,
  setMemoryModel,
  setMemoryLanguage,
} from "./options";
import { listWorkspaces } from "./workspaces";
import { registerAssistantAgentsRoutes } from "./routes/assistant-agents";
import { changeAssistantWorkspace } from "./assistant-settings";
import { PasskeyAuthService, formatSetupCode } from "./passkeys";
import { verifyAuthToken, authCacheScope } from "./auth";
import { TranscriptImages, imagePreview } from "./transcript-images";
import { createLoginRateLimiter } from "./login-rate-limit";
import { registerAuthRoutes } from "./routes/auth";
import { appBasePath, renderAppShell } from "./app-shell";
import { registerBrowserErrorRoutes } from "./browser-errors";
import { registerCronRoutes } from "./routes/cron";
import { registerSiteRoutes } from "./routes/sites";
import { registerMcpRoutes } from "./routes/mcp";
import { registerMemoryTreeRoutes } from "./routes/memory-tree";
import { Runtime, context } from "./runtime";
import { acquireLock } from "./lock";
import { resolveUploadedFile } from "./uploads";
import { registerSessionRoutes } from "./routes/sessions";
import { resolveSentFile } from "./send-files";
import type { AppColor } from "@/shared/appearance";
import { WebPushService } from "./web-push";
import { registerPushCompletions } from "./push-completions";

const config = await loadConfig(resolveBattyDir());
await fs.mkdir(stateDirPath(config.battyDir), { recursive: true });
const releaseLock = await acquireLock(path.join(stateDirPath(config.battyDir), "runtime.lock"));
const webPush = new WebPushService(config);
await webPush.initialize();
let stopPushCompletions!: () => void;
const runtime = await Runtime.open(config, {
  resume: false,
  beforeStart: (runtime) => {
    stopPushCompletions = registerPushCompletions(runtime, webPush, (error) =>
      console.error("Push completions", error),
    );
  },
});
const transcriptImages = new TranscriptImages(
  path.join(stateDirPath(config.battyDir), "transcript-images"),
  config.baseUrl,
);
const passkeys = new PasskeyAuthService(config.battyDir, config.authSecret);
const setup = await passkeys.initialize();
if (setup)
  console.log(
    `Setup code: ${formatSetupCode(setup.code)} (expires ${new Date(setup.expiresAt).toISOString()})`,
  );
const app = fastify({
  logger: true,
  trustProxy: ["127.0.0.1", "::1"],
  bodyLimit: 100 * 1024 * 1024,
});
await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
app.decorateRequest("auth", false);
declare module "fastify" {
  interface FastifyRequest {
    auth: boolean;
  }
}
const publicApis = new Set([
  "/api/bootstrap",
  "/api/version",
  "/api/logout",
  "/api/auth/login/options",
  "/api/auth/login/verify",
  "/api/auth/register/options",
  "/api/auth/register/verify",
]);
app.addHook("onRequest", async (request, reply) => {
  request.auth = verifyAuthToken(config.authSecret, request.cookies[config.cookieName]);
  const pathname = request.url.split("?", 1)[0]!;
  if (pathname.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  const correlationId = request.headers["x-batty-correlation-id"];
  if (
    request.auth &&
    ["/api/main/prompt", "/api/main/steer"].includes(pathname) &&
    typeof correlationId === "string" &&
    /^[a-f0-9-]{36}$/.test(correlationId)
  )
    request.log.info({ correlationId }, "Browser submission");
  if (pathname.startsWith("/api/") && !publicApis.has(pathname) && !request.auth)
    return reply.code(401).send({ error: "Authentication required" });
});
const routeContext = {
  app,
  config,
  passkeys,
  authAttemptLimiter: createLoginRateLimiter(),
  routePath: (route: string) => route,
};
registerAuthRoutes(routeContext);
registerBrowserErrorRoutes(app, path.join(stateDirPath(config.battyDir), "browser-errors.json"));
registerCronRoutes(app, runtime.orchestration);
registerSiteRoutes(routeContext);
registerMcpRoutes({ ...routeContext, mcp: runtime.tools.mcp });
registerMemoryTreeRoutes(app, runtime.memory);
app.get("/api/push/public-key", async () => ({ publicKey: webPush.getPublicKey() }));
app.post<{ Body: { subscription: PushSubscriptionJSON } }>(
  "/api/push/subscriptions",
  async (request) => {
    await webPush.upsertSubscription(request.body.subscription);
    return { ok: true };
  },
);
app.post<{ Body: { endpoint: string } }>("/api/push/subscriptions/delete", async (request) => {
  await webPush.removeSubscription(request.body.endpoint);
  return { ok: true };
});
runtime.harness.resume();
const buildId =
  process.env.BATTY_BUILD_ID ??
  (
    await fs
      .readFile(path.join(config.selfPath, "BUILD_ID"), "utf8")
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "dev";
        throw error;
      })
  ).trim();
function settingsStatus() {
  return {
    braveSearchConfigured: Boolean(config.braveSearchKey),
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
    memoryModel: config.memoryModel,
    memoryLanguage: config.memoryLanguage,
    memoryReasoning: process.env.BATTY_MEMORY_REASONING ?? "low",
    defaultThinkingLevel: config.defaultThinkingLevel,
    appearance: { title: config.appTitle, color: config.appColor },
    pushTitle: config.pushTitle,
  };
}
app.get("/healthz", async () => ({ ok: true, mainSessionId: String(runtime.main.id), buildId }));
app.get("/api/version", async (_request, reply) => {
  reply.header("Cache-Control", "no-store");
  return { buildId };
});
app.get("/api/bootstrap", async (request) => ({
  authenticated: request.auth,
  ...(request.auth ? authCacheScope(config.authSecret, request.cookies[config.cookieName]!) : {}),
  auth: request.auth
    ? await passkeys.getStatus()
    : {
        passkeyCount: 0,
        passkeyLoginAvailable: false,
        registrationOpen: false,
        setupRequired: false,
      },
  providerAuth: request.auth ? runtime.providerAuth.getStatus() : { providers: [] },
  settings: settingsStatus(),
  buildId,
  workspaceRoots: request.auth ? config.workspacesRoots : [],
  workspaces: request.auth ? await listWorkspaces(config) : [],
  workspaceUiSettings: {},
  workspaceSnapshots: [],
  models: request.auth ? await runtime.listModels() : [],
}));
app.get("/api/workspaces", async () => ({ workspaces: await listWorkspaces(config) }));
app.post<{ Body: { workspaceId: string } }>("/api/settings/assistant-workspace", async (request) =>
  changeAssistantWorkspace(config, request.body.workspaceId, {
    state: () => runtime.state("main", undefined, false),
    configure: (cwd) => runtime.main.configure({ cwd }, context),
  }),
);
app.get("/api/models", async () => runtime.listModels());
app.get<{ Params: { sessionId: string } }>(
  "/api/sessions/:sessionId/resources",
  async (request) => {
    const conversation = await runtime.conversation(request.params.sessionId);
    const agent = await conversation.agent(context);
    return {
      skills: (await runtime.resources.sessionSkills(agent.cwd ?? config.selfPath)).map(
        (skill) => ({
          name: skill.name,
          description: skill.description,
          filePath: skill.filePath,
        }),
      ),
      tools: agent.tools.map((tool) => ({ name: tool.name, description: tool.description })),
    };
  },
);
app.get<{ Params: { sessionId: string } }>(
  "/api/sessions/:sessionId/subagents",
  async (request) => {
    const conversation = await runtime.conversation(request.params.sessionId);
    return (await runtime.orchestration.listRunning(conversation.id)).map((worker) => ({
      ...worker,
      sessionPath: `durable:${worker.sessionId}`,
      parentSessionId: String(worker.parentId),
      model: config.defaultModel,
      thinkingLevel: config.defaultThinkingLevel,
      startedAtMs: worker.startedAtMs,
    }));
  },
);
function scheduleLabel(schedule: {
  kind: string;
  at?: string;
  every?: string;
  expression?: string;
  timezone?: string;
}) {
  return schedule.kind === "at"
    ? `At ${schedule.at}`
    : schedule.kind === "every"
      ? `Every ${schedule.every}`
      : `${schedule.expression} (${schedule.timezone})`;
}
app.get<{ Params: { workspaceId: string } }>(
  "/api/workspaces/:workspaceId/cron-jobs",
  async (request) =>
    (await runtime.orchestration.listJobs(request.params.workspaceId)).map((job) => ({
      ...job,
      model: job.model ?? `${config.defaultProvider}/${config.defaultModel}`,
      thinkingLevel: job.thinkingLevel ?? config.defaultThinkingLevel,
      scheduleLabel: scheduleLabel(job.schedule),
      state: { nextRunAtMs: job.nextAt },
    })),
);
app.get<{ Params: { workspaceId: string } }>(
  "/api/workspaces/:workspaceId/cron-run-logs",
  async (request) => {
    const jobs = await runtime.orchestration.listJobs();
    return (
      await runtime.orchestration.listRunLogs(undefined, 100, request.params.workspaceId)
    ).map((run) => {
      const job = jobs.find((item) => item.id === run.jobId) ?? run.job;
      return {
        runId: run.id,
        jobId: run.jobId,
        workspaceId: run.workspaceId,
        prompt: job?.prompt ?? "",
        model: job?.model ?? `${config.defaultProvider}/${config.defaultModel}`,
        thinkingLevel: job?.thinkingLevel ?? config.defaultThinkingLevel,
        session: job?.session ?? { kind: "new" },
        scheduleLabel: job ? scheduleLabel(job.schedule) : "",
        startedAtMs: run.startedAt,
        sessionId: run.sessionId,
        sessionPath: `durable:${run.sessionId}`,
        status:
          run.status === "running" ? "running" : run.status === "completed" ? "success" : "error",
        completedAtMs: run.finishedAt,
        durationMs: run.finishedAt ? run.finishedAt - run.startedAt : undefined,
        error: run.status === "failed" ? run.output : undefined,
      };
    });
  },
);
app.get("/api/memory/status", async () => runtime.memory.status());
app.get("/api/memory/usage", async () => runtime.memory.usage());
const closeEventStreams = registerSessionRoutes(app, runtime, transcriptImages);
app.post("/api/main/stop", async () => {
  await runtime.tools.abortConversation(runtime.main.id);
  await runtime.main.abort(context);
  return { ok: true };
});
app.delete<{ Params: { submissionId: string } }>(
  "/api/main/queue/:submissionId",
  async (request) => ({
    result: await runtime.harness.abortSubmission(
      Number(request.params.submissionId) as SubmissionId,
      context,
      runtime.main.id,
    ),
  }),
);
app.post<{ Body: { kind: string; index: number } }>("/api/main/queue/remove", async (request) => {
  await runtime.harness.abortSubmission(
    Number(request.body.index) as SubmissionId,
    context,
    runtime.main.id,
  );
  return runtime.state();
});
app.get("/api/provider-auth/status", async () => runtime.providerAuth.getStatus());
app.get<{ Querystring: { provider: string; model: string } }>(
  "/api/provider-usage",
  async (request) => runtime.providerUsage.getUsage(request.query.provider, request.query.model),
);
app.post("/api/provider-auth/openai/start", async () => runtime.providerAuth.start("openai"));
app.get<{ Params: { attemptId: string } }>(
  "/api/provider-auth/openai/attempt/:attemptId",
  async (request) => runtime.providerAuth.getAttemptStatus(request.params.attemptId),
);
app.post<{ Body: { attemptId: string; callbackUrl: string } }>(
  "/api/provider-auth/openai/complete",
  async (request) => {
    await runtime.providerAuth.complete(request.body.attemptId, request.body.callbackUrl);
    return runtime.providerAuth.getStatus();
  },
);
app.post<{ Body: { providerId: string; apiKey: string } }>(
  "/api/provider-auth/api-key",
  async (request) => {
    await runtime.models.setRuntimeApiKey(request.body.providerId, request.body.apiKey);
    return runtime.providerAuth.getStatus();
  },
);
app.post<{ Body: { providerId: string } }>("/api/provider-auth/logout", async (request) => {
  await runtime.models.logout(request.body.providerId);
  return runtime.providerAuth.getStatus();
});
app.post<{ Body: { apiKey: string } }>("/api/settings/brave-search", async (request) => {
  config.braveSearchKey = (
    await setBraveSearchKey(config.battyDir, request.body.apiKey)
  ).braveSearchKey;
  return settingsStatus();
});
app.post<{ Body: { title: string; color: AppColor } }>(
  "/api/settings/appearance",
  async (request) => {
    const settings = await setAppearance(config.battyDir, request.body.title, request.body.color);
    config.appTitle = settings.appTitle;
    config.appColor = settings.appColor;
    return settingsStatus();
  },
);
app.post<{ Body: { modelId: string; thinkingLevel: string } }>(
  "/api/settings/default-model",
  async (request) => {
    const slash = request.body.modelId.indexOf("/");
    const settings = await setDefaultModel(
      config.battyDir,
      request.body.modelId.slice(0, slash),
      request.body.modelId.slice(slash + 1),
      request.body.thinkingLevel,
    );
    Object.assign(config, {
      defaultProvider: settings.defaultProvider,
      defaultModel: settings.defaultModel,
      defaultThinkingLevel: settings.defaultThinkingLevel,
    });
    return settingsStatus();
  },
);
app.post<{ Body: { language: string } }>(
  "/api/settings/memory-language",
  async (request, reply) => {
    const language = request.body.language.trim();
    if (!language) return reply.code(400).send({ error: "Enter a memory language" });
    const settings = await setMemoryLanguage(config.battyDir, language);
    config.memoryLanguage = settings.memoryLanguage;
    return settingsStatus();
  },
);
app.post<{ Body: { modelId: string } }>("/api/settings/memory-model", async (request) => {
  const settings = await setMemoryModel(config.battyDir, request.body.modelId);
  config.memoryModel = settings.memoryModel;
  return settingsStatus();
});
app.post<{ Body: { title: string } }>("/api/settings/push-title", async (request, reply) => {
  const title = request.body.title.trim();
  if (!title) return reply.code(400).send({ error: "Enter a push title" });
  const settings = await setPushTitle(config.battyDir, title);
  config.pushTitle = settings.pushTitle;
  return settingsStatus();
});
app.get("/api/settings/environment", async () => ({
  names: Object.keys(await readEnvironmentFile(config.battyDir)).sort(),
}));
app.put<{ Params: { name: string }; Body: { value: string } }>(
  "/api/settings/environment/:name",
  async (request) => ({
    names: await updateEnvironmentFile(config.battyDir, request.params.name, request.body.value),
  }),
);
app.delete<{ Params: { name: string } }>("/api/settings/environment/:name", async (request) => ({
  names: await updateEnvironmentFile(config.battyDir, request.params.name),
}));
registerAssistantAgentsRoutes(app, config);
app.get("/api/settings/agents", async () => ({
  content: await fs.readFile(path.join(stateDirPath(config.battyDir), "AGENTS.md"), "utf8"),
}));
app.post<{ Body: { content: string } }>("/api/settings/agents", async (request) => {
  await fs.writeFile(path.join(stateDirPath(config.battyDir), "AGENTS.md"), request.body.content);
  return { content: request.body.content };
});
app.get("/api/auth/status", async () => passkeys.getStatus());
app.post("/api/auth/setup-code", async () => passkeys.issueSetupCode("settings"));
app.get<{ Params: { imageId: string }; Querystring: { preview?: string } }>(
  "/api/transcript-images/:imageId",
  async (request, reply) => {
    const file = await transcriptImages.resolve(
      request.params.imageId,
      request.query.preview === "1",
    );
    return reply
      .header("Cache-Control", "no-store")
      .type(file.mimeType)
      .send(createReadStream(file.path));
  },
);
app.get<{
  Params: { sessionId: string; batchId: string; name: string };
  Querystring: { preview?: string };
}>("/api/uploads/:sessionId/:batchId/:name", async (request, reply) => {
  const file = await resolveUploadedFile(
    config.uploadsDir,
    request.params.sessionId,
    request.params.batchId,
    request.params.name,
  );
  if (request.query.preview === "1" && file.mimeType.startsWith("image/"))
    return reply
      .type("image/webp")
      .header("Cache-Control", "no-store")
      .send(await imagePreview(file.path));
  return reply.type(file.mimeType).send(createReadStream(file.path));
});
app.get<{
  Params: { workspaceId: string; sessionId: string; toolCallId: string; fileId: string };
  Querystring: { download?: string; preview?: string };
}>("/api/sent-files/:workspaceId/:sessionId/:toolCallId/:fileId", async (request, reply) => {
  const file = await resolveSentFile({
    rootDir: config.sentFilesDir,
    baseUrl: config.baseUrl,
    ...request.params,
  });
  if (request.query.preview === "1" && file.descriptor.kind === "image")
    return reply
      .type("image/webp")
      .header("Cache-Control", "no-store")
      .send(await imagePreview(file.storedPath));
  reply.type(file.descriptor.mimeType);
  if (request.query.download)
    reply.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(file.descriptor.name)}`,
    );
  return reply.send(createReadStream(file.storedPath));
});

const appBase = appBasePath(config.baseUrl);
const index = renderAppShell(
  await fs.readFile(path.join(config.publicDir, "index.html"), "utf8"),
  config.baseUrl,
);
app.get("/manifest.webmanifest", async () => ({
  name: config.appTitle,
  short_name: config.appTitle,
  display: "standalone",
  start_url: appBase,
  scope: appBase,
  theme_color: "#ffffff",
  background_color: "#ffffff",
  icons: [
    { src: `${appBase}pwa-192.png`, sizes: "192x192", type: "image/png" },
    { src: `${appBase}pwa-512.png`, sizes: "512x512", type: "image/png" },
  ],
}));
app.get("/index.html", async (_request, reply) => reply.type("text/html").send(index));
await app.register(staticFiles, { root: config.publicDir, prefix: "/" });
app.get("/", async (_request, reply) => reply.type("text/html").send(index));
app.setNotFoundHandler((request, reply) =>
  request.url.startsWith("/api/")
    ? reply.code(404).send({ error: "Not found" })
    : reply.type("text/html").send(index),
);
app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  const failure = error as Error & { statusCode?: number };
  reply.code(failure.statusCode ?? 500).send({ error: failure.message });
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  // Close the harness first: checkpoint work, do not drain or cancel admitted runs.
  stopPushCompletions();
  await runtime.close();
  closeEventStreams();
  await app.close();
  await releaseLock();
  process.exit(0);
}
// WinSW stoparguments asks the parent to checkpoint and exit without killing
// detached shell supervisors or Chromium processes.
app.post("/api/service/stop", async (request, reply) => {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip))
    return reply.code(403).send({ error: "Service stop requires a local request" });
  reply.send({ ok: true });
  setImmediate(() => void shutdown());
});
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
await app.listen({ host: config.host, port: config.port });
