import fs from "node:fs/promises";
import { createOwnerRpcHandler } from "./owner-rpc";
import path from "node:path";
import { createReadStream } from "node:fs";
import fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import { loadConfig, resolveBattyDir } from "./config";
import { stateDirPath } from "./options";
import { listWorkspaces } from "./workspaces";
import { PasskeyAuthService, formatSetupCode } from "./passkeys";
import { verifyAuthToken, authCacheScope } from "./auth";
import { TranscriptImages, imagePreview } from "./transcript-images";
import { createLoginRateLimiter } from "./login-rate-limit";
import { registerAuthRoutes } from "./routes/auth";
import { appBasePath, renderAppShell } from "./app-shell";
import { createBrowserErrorReporter } from "./browser-errors";
import { registerCronRoutes } from "./routes/cron";
import { registerSiteRoutes } from "./routes/sites";
import { registerCloudBrowserRoutes } from "./routes/cloud-browser";
import { cloudBrowserAvailable, registerCloudBrowserLauncher } from "./cloud-browser-launcher";
import { Runtime } from "./runtime";
import { acquireLock } from "./lock";
import { resolveUploadedFile } from "./uploads";
import {
  registerRemoteRoutes,
  authenticateNode,
  executeRemoteOwnerOperation,
} from "./routes/remotes";
import { registerReverseRemoteRoutes, registerRpcSocketTransport } from "./routes/reverse-remotes";
import { resolveSentFile } from "./send-files";
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
await registerRpcSocketTransport(app);
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
registerRemoteRoutes(app, runtime);
registerReverseRemoteRoutes(app, runtime, (operation, input, rpc) =>
  ownerHandler(operation, input, rpc),
);
const reportBrowserError = createBrowserErrorReporter(
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
  await runtime.close();
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
