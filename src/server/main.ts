import fs from "node:fs/promises";
import { createOwnerRpcHandler } from "./owner-rpc";
import path from "node:path";
import { createReadStream } from "node:fs";
import fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { loadConfig, resolveBattyDir, readEnvironmentFile } from "./config";
import { stateDirPath } from "./options";
import { listWorkspaces } from "./workspaces";
import { registerWorkspaceFileRoutes } from "./routes/workspace-files";
import { registerAssistantAgentsRoutes } from "./routes/assistant-agents";
import { PasskeyAuthService, formatSetupCode } from "./passkeys";
import { verifyAuthToken, authCacheScope } from "./auth";
import { TranscriptImages, imagePreview } from "./transcript-images";
import { createLoginRateLimiter } from "./login-rate-limit";
import { registerAuthRoutes } from "./routes/auth";
import { registerSettingsCopyRoute } from "./routes/settings-copy";
import { appBasePath, renderAppShell } from "./app-shell";
import { registerBrowserErrorRoutes } from "./browser-errors";
import { registerCronRoutes } from "./routes/cron";
import { registerSiteRoutes } from "./routes/sites";
import { registerCloudBrowserRoutes } from "./routes/cloud-browser";
import { cloudBrowserAvailable, registerCloudBrowserLauncher } from "./cloud-browser-launcher";
import { registerMcpRoutes } from "./routes/mcp";
import { registerMemoryTreeRoutes } from "./routes/memory-tree";
import { Runtime, context } from "./runtime";
import { acquireLock } from "./lock";
import { resolveUploadedFile } from "./uploads";
import { registerSessionRoutes } from "./routes/sessions";
import { streamAppStatus } from "./app-status-stream";
import {
  registerRemoteRoutes,
  authenticateNode,
  executeRemoteOwnerOperation,
} from "./routes/remotes";
import { registerReverseRemoteRoutes } from "./routes/reverse-remotes";
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
  forceCloseConnections: true,
  routerOptions: { maxParamLength: 256 },
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
  if (pathname.startsWith("/api/node/")) {
    return authenticateNode(request, reply, runtime.remotes.access);
  }
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
registerSettingsCopyRoute(app, async (kind, name) => {
  if (kind === "provider") return runtime.providerAuth.getApiKey(name);
  if (kind === "brave-search") return config.braveSearchKey || undefined;
  const environment = await readEnvironmentFile(config.battyDir);
  return Object.hasOwn(environment, name) ? environment[name] : undefined;
});
const closeRemoteStreams = registerRemoteRoutes(app, runtime);
await registerReverseRemoteRoutes(app, runtime, (operation, input, rpc) =>
  ownerHandler(operation, input, rpc),
);
const reportBrowserError = registerBrowserErrorRoutes(
  app,
  path.join(stateDirPath(config.battyDir), "browser-errors.json"),
);
registerCronRoutes(app, runtime.orchestration);
registerSiteRoutes(routeContext);
const closeCloudBrowsers = await registerCloudBrowserRoutes(
  app,
  runtime.tools.browserService,
  config.baseUrl,
);
const browserAvailable = await cloudBrowserAvailable();
registerCloudBrowserLauncher(
  app,
  runtime.tools.browserService,
  config.baseUrl,
  browserAvailable,
  async () => (await listWorkspaces(config)).map((workspace) => workspace.id),
);
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
app.post<{ Body: { clientId: string; challengeId: string } }>(
  "/api/push/foreground/ack",
  async (request) => ({
    ok: webPush.foreground.acknowledge(request.body.clientId, request.body.challengeId),
  }),
);
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
    cloudBrowserAvailable: browserAvailable,
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
const ownerHandler = createOwnerRpcHandler(runtime, {
  transcriptImages,
  webPush,
  passkeys,
  settingsStatus,
  buildId,
  browserAvailable,
  reportBrowserError,
  logSubmission: (correlationId) => app.log.info({ correlationId }, "Browser submission"),
  remoteOperation: (operation, input) =>
    executeRemoteOwnerOperation(
      runtime,
      operation,
      input as Parameters<typeof executeRemoteOwnerOperation>[2],
    ),
});
const ownerValue = async (operation: string, input: unknown = {}) => {
  try {
    return (await ownerHandler(operation, input, { signal: new AbortController().signal })).value;
  } catch (error) {
    const failure = error as Error & { code?: string };
    const statusCode =
      (
        {
          BAD_INPUT: 400,
          UNAUTHORIZED: 401,
          FORBIDDEN: 403,
          NOT_FOUND: 404,
          CONFLICT: 409,
          GONE: 410,
          RATE_LIMITED: 429,
          UNAVAILABLE: 501,
          OFFLINE: 503,
          TIMEOUT: 504,
        } as Record<string, number>
      )[failure.code ?? ""] ?? 500;
    throw Object.assign(failure, { statusCode });
  }
};

app.get("/api/workspaces", () => ownerValue("workspace.list"));
registerWorkspaceFileRoutes(app, config);
app.post<{ Body: { workspaceId: string } }>("/api/settings/assistant-workspace", (request) =>
  ownerValue("settings.assistant-workspace", request.body),
);
app.get("/api/models", () => ownerValue("models.list"));
app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/resources", (request) =>
  ownerValue("session.resources", request.params),
);
app.get<{ Params: { workspaceId: string } }>("/api/workspaces/:workspaceId/cron-jobs", (request) =>
  ownerValue("workspace.cron.jobs", request.params),
);
app.get<{ Params: { workspaceId: string } }>(
  "/api/workspaces/:workspaceId/cron-run-logs",
  (request) => ownerValue("workspace.cron.logs", request.params),
);
app.get("/api/cron/running", () => ownerValue("cron.running"));
app.get("/api/memory/status", () => ownerValue("memory.status"));
app.get("/api/memory/usage", () => ownerValue("memory.usage"));
const closeEventStreams = registerSessionRoutes(
  app,
  runtime,
  transcriptImages,
  webPush.foreground,
  (stream) => streamAppStatus(stream, runtime, buildId, (error) => app.log.error(error)),
);
app.post("/api/main/stop", () => ownerValue("main.stop"));
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
app.post<{ Body: { kind: string; index: number } }>("/api/main/queue/remove", (request) =>
  ownerValue("main.queue.remove", request.body),
);
app.get("/api/provider-auth/status", () => ownerValue("provider.status"));
app.get<{ Querystring: { provider: string; model: string } }>("/api/provider-usage", (request) =>
  ownerValue("provider.usage", request.query),
);
app.post<{ Body: { providerId: string } }>("/api/provider-auth/start", (request) =>
  ownerValue("provider.start", request.body),
);
app.get<{ Params: { attemptId: string } }>("/api/provider-auth/attempt/:attemptId", (request) =>
  ownerValue("provider.attempt", request.params),
);
app.post<{ Body: { attemptId: string; callbackUrl: string } }>(
  "/api/provider-auth/complete",
  (request) => ownerValue("provider.complete", request.body),
);
app.post<{ Body: { providerId: string; apiKey: string } }>(
  "/api/provider-auth/api-key",
  (request) => ownerValue("provider.key", request.body),
);
app.post<{ Body: { providerId: string } }>("/api/provider-auth/logout", (request) =>
  ownerValue("provider.logout", request.body),
);
app.post<{ Body: { apiKey: string } }>("/api/settings/brave-search", (request) =>
  ownerValue("settings.brave-search", request.body),
);
app.post<{ Body: { title: string; color: AppColor } }>("/api/settings/appearance", (request) =>
  ownerValue("settings.appearance", request.body),
);
app.post<{ Body: { modelId: string; thinkingLevel: string } }>(
  "/api/settings/default-model",
  (request) => ownerValue("settings.default-model", request.body),
);
app.post<{ Body: { language: string } }>("/api/settings/memory-language", (request) =>
  ownerValue("settings.memory-language", request.body),
);
app.post<{ Body: { modelId: string } }>("/api/settings/memory-model", (request) =>
  ownerValue("settings.memory-model", request.body),
);
app.post<{ Body: { title: string } }>("/api/settings/push-title", (request) =>
  ownerValue("settings.push-title", request.body),
);
app.get("/api/settings/environment", () => ownerValue("environment.list"));
app.put<{ Params: { name: string }; Body: { value: string } }>(
  "/api/settings/environment/:name",
  (request) => ownerValue("environment.set", { ...request.params, ...request.body }),
);
app.delete<{ Params: { name: string } }>("/api/settings/environment/:name", (request) =>
  ownerValue("environment.remove", request.params),
);
registerAssistantAgentsRoutes(app, config);
app.get("/api/settings/agents", () => ownerValue("agents.get"));
app.post<{ Body: { content: string } }>("/api/settings/agents", (request) =>
  ownerValue("agents.set", request.body),
);
app.get("/api/auth/status", () => ownerValue("auth.status"));
app.post("/api/auth/setup-code", () => ownerValue("auth.setup-code"));
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
  await closeCloudBrowsers();
  closeRemoteStreams();
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
