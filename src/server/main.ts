import fs from "node:fs/promises";
import path from "node:path";
import fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import { verifyAuthToken } from "./auth";
import { readBuildId } from "./build-id";
import { loadConfig, resolveBattyDir } from "./config";
import { CronService } from "./cron";
import { createLoginRateLimiter } from "./login-rate-limit";
import { formatSetupCode, PasskeyAuthService } from "./passkeys";
import { PiService } from "./pi-service";
import type { WorkspaceSnapshot, WorkspaceUiSettings } from "@/shared/types";
import { registerAuthRoutes } from "./routes/auth";
import { registerCronRoutes } from "./routes/cron";
import type { RouteContext } from "./routes/context";
import { registerPushRoutes } from "./routes/push";
import { registerSessionRoutes } from "./routes/sessions";
import { registerSettingsRoutes } from "./routes/settings";
import { registerWorkspaceRoutes } from "./routes/workspaces";
import { WebPushService } from "./web-push";
import { appColorOption } from "@/shared/appearance";
import { listWorkspaces, resolveWorkspace } from "./workspaces";

const config = await loadConfig(resolveBattyDir());
const passkeys = new PasskeyAuthService(config.battyDir, config.authSecret);
const bootstrapSetupCode = await passkeys.initialize();
const webPush = new WebPushService(config);
await webPush.initialize();
const cronService = new CronService(config);
const workspaceSubscribers = new Map<string, Set<(snapshot: WorkspaceSnapshot) => void>>();
const workspaceUiSettings = new Map<string, WorkspaceUiSettings>();

function getWorkspaceUiSettings(workspaceId: string): WorkspaceUiSettings {
  return workspaceUiSettings.get(workspaceId) ?? { easyMode: false };
}

async function setWorkspaceUiSettings(
  workspaceId: string,
  patch: Partial<WorkspaceUiSettings>,
): Promise<WorkspaceUiSettings> {
  const next = { ...getWorkspaceUiSettings(workspaceId), ...patch };
  workspaceUiSettings.set(workspaceId, next);
  await publishWorkspace(workspaceId);
  return next;
}

async function workspaceSnapshot(workspaceId: string): Promise<WorkspaceSnapshot> {
  const workspaces = await listWorkspaces(config);
  const workspace = resolveWorkspace(workspaces, workspaceId);
  return {
    workspaceId,
    sessions: await service.listSessionSummaries(workspace),
    cronJobs: cronService.listJobs(workspaceId),
    runningCronJobs: cronService.listRunningJobs(workspaceId),
    cronRunLogs: cronService.listRecentRunLogs(workspaceId),
    uiSettings: getWorkspaceUiSettings(workspaceId),
  };
}

async function publishWorkspace(workspaceId: string): Promise<void> {
  const subscribers = workspaceSubscribers.get(workspaceId);
  if (!subscribers || subscribers.size === 0) {
    return;
  }

  const snapshot = await workspaceSnapshot(workspaceId);
  for (const subscriber of subscribers) {
    subscriber(snapshot);
  }
}

const service = await PiService.create(
  config,
  cronService,
  async (session) => {
    await webPush.notifyAgentCompleted(session);
  },
  async (workspaceId) => {
    await publishWorkspace(workspaceId);
  },
);
cronService.subscribe((workspaceIds) => {
  for (const workspaceId of workspaceIds) {
    void publishWorkspace(workspaceId).catch((error) => {
      console.error("Failed to publish workspace update", { workspaceId, error });
    });
  }
});
cronService.setRunner({
  run: async (job, runContext) => {
    const workspaces = await listWorkspaces(config);
    const workspace = resolveWorkspace(workspaces, job.workspaceId);
    return service.runCronJobSession({
      workspace,
      prompt: job.prompt,
      model: job.model,
      thinkingLevel: job.thinkingLevel,
      session: job.session,
      scheduleLabel: job.scheduleLabel,
      jobId: job.id,
      runId: runContext.runId,
      signal: runContext.signal,
      onSessionStarted: runContext.onSessionStarted,
    });
  },
  onSkipped: async (job, skippedContext) => {
    const workspaces = await listWorkspaces(config);
    const workspace = resolveWorkspace(workspaces, job.workspaceId);
    await service.deliverSkippedCronJobRun(
      {
        workspace,
        prompt: job.prompt,
        model: job.model,
        thinkingLevel: job.thinkingLevel,
        session: job.session,
        scheduleLabel: job.scheduleLabel,
        jobId: job.id,
        runId: skippedContext.runId,
      },
      skippedContext,
    );
  },
});
await cronService.initialize();

const authAttemptLimiter = createLoginRateLimiter();

const app = fastify({
  logger: true,
  trustProxy: ["127.0.0.1", "::1"],
  bodyLimit: 1024 * 1024 * 100,
});
app.addHook("onClose", async () => {
  await Promise.all([service.dispose(), cronService.dispose()]);
});

if (bootstrapSetupCode) {
  console.log(`Setup code: ${formatSetupCode(bootstrapSetupCode.code)}`);
  console.log(`Expires at: ${new Date(bootstrapSetupCode.expiresAt).toISOString()}`);
}

await fs.mkdir(config.uploadsDir, { recursive: true });
await fs.mkdir(config.sentFilesDir, { recursive: true });

await app.register(cookie);
await app.register(multipart);
const hasBuiltClient = await fs
  .access(path.join(config.publicDir, "index.html"))
  .then(() => true)
  .catch(() => false);
const buildId = await readBuildId(config.publicDir);
const appBaseUrl = config.baseUrl;
const appBaseHref = appBaseUrl === "/" ? "/" : `${appBaseUrl}/`;
const clientIndexHtml = hasBuiltClient
  ? await fs.readFile(path.join(config.publicDir, "index.html"), "utf8")
  : undefined;

function routePath(route: string): string {
  return appBaseUrl === "/" ? route : `${appBaseUrl}${route}`;
}

function stripBaseUrl(url: string): string | undefined {
  const pathname = url.split("?", 1)[0]?.split("#", 1)[0] ?? "/";
  if (appBaseUrl === "/") {
    return pathname;
  }
  if (pathname === appBaseUrl) {
    return "/";
  }
  if (!pathname.startsWith(`${appBaseUrl}/`)) {
    return undefined;
  }
  return pathname.slice(appBaseUrl.length);
}

function escapeHtmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderClientHtml(): string {
  if (!clientIndexHtml) {
    throw new Error("Client build not available");
  }

  const color = appColorOption(config.appColor);
  const configScript = `<script>window.__BATTY_BASE_URL__=${JSON.stringify(appBaseUrl).replace(/</g, "\\u003C")};</script>`;
  const appearanceStyle = `<style>:root{--color-instance-light:${color.light};--color-instance-dark:${color.dark}}</style>`;
  return clientIndexHtml
    .replace("<title>Batty</title>", `<title>${escapeHtmlText(config.appTitle)}</title>`)
    .replace(
      '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />',
      `<meta name="theme-color" content="${color.light}" media="(prefers-color-scheme: light)" />`,
    )
    .replace(
      '<meta name="theme-color" content="#172128" media="(prefers-color-scheme: dark)" />',
      `<meta name="theme-color" content="${color.dark}" media="(prefers-color-scheme: dark)" />`,
    )
    .replace(
      "<head>",
      `<head>\n    <base href="${appBaseHref}" />\n    ${configScript}\n    ${appearanceStyle}`,
    );
}

app.get(routePath("/manifest.webmanifest"), async (_request, reply) => {
  const color = appColorOption(config.appColor);
  reply.type("application/manifest+json");
  return {
    name: config.appTitle,
    short_name: config.appTitle,
    description: "Browser UI for Pi Coding Agent",
    theme_color: color.light,
    background_color: color.light,
    display: "standalone",
    start_url: ".",
    scope: ".",
    icons: [
      { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
      { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
});

if (hasBuiltClient) {
  await app.register(staticFiles, {
    root: config.publicDir,
    prefix: appBaseHref,
  });
}

function isAuthenticated(token?: string): boolean {
  return verifyAuthToken(config.authSecret, token);
}

function shouldServeClientApp(url: string): boolean {
  const pathname = stripBaseUrl(url);
  if (!pathname || pathname.startsWith("/api")) {
    return false;
  }
  if (pathname === "/") {
    return true;
  }
  return path.extname(pathname) === "";
}

function allowUnauthenticatedApi(pathname: string | undefined): boolean {
  if (!pathname) {
    return false;
  }
  return (
    pathname === "/api/bootstrap" ||
    pathname === "/api/version" ||
    pathname === "/api/logout" ||
    pathname === "/api/auth/login/options" ||
    pathname === "/api/auth/login/verify" ||
    pathname === "/api/auth/register/options" ||
    pathname === "/api/auth/register/verify"
  );
}

app.decorateRequest("auth", false);

declare module "fastify" {
  interface FastifyRequest {
    auth: boolean;
  }
}

app.addHook("onRequest", async (request, reply) => {
  request.auth = isAuthenticated(request.cookies[config.cookieName]);

  const pathname = stripBaseUrl(request.url);
  if (pathname?.startsWith("/api") && !allowUnauthenticatedApi(pathname) && !request.auth) {
    reply.code(401).send({ error: "Authentication required" });
  }
});

if (hasBuiltClient) {
  app.get(routePath("/"), async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return reply.send(renderClientHtml());
  });

  if (appBaseHref !== "/" && appBaseHref !== routePath("/")) {
    app.get(appBaseHref, async (_request, reply) => {
      reply.type("text/html; charset=utf-8");
      return reply.send(renderClientHtml());
    });
  }

  app.get(routePath("/index.html"), async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return reply.send(renderClientHtml());
  });
}

const routeContext: RouteContext = {
  app,
  config,
  passkeys,
  service,
  cronService,
  webPush,
  authAttemptLimiter,
  buildId,
  routePath,
  workspaceSnapshot,
  getWorkspaceUiSettings,
  setWorkspaceUiSettings,
};

registerAuthRoutes(routeContext);
registerSettingsRoutes(routeContext);
registerPushRoutes(routeContext);
registerWorkspaceRoutes(routeContext, workspaceSubscribers);
registerCronRoutes(routeContext);
registerSessionRoutes(routeContext);

app.get("/healthz", async () => ({ ok: true }));
if (appBaseUrl !== "/") {
  app.get(routePath("/healthz"), async () => ({ ok: true }));
}

app.setNotFoundHandler((request, reply) => {
  if (hasBuiltClient && shouldServeClientApp(request.url)) {
    reply.type("text/html; charset=utf-8");
    return reply.send(renderClientHtml());
  }

  reply.code(404).send({ error: "Not found" });
});

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  const errorWithStatus = error as Error & { statusCode?: number };
  const statusCode =
    typeof errorWithStatus.statusCode === "number" ? errorWithStatus.statusCode : 500;
  reply.code(statusCode).send({ error: errorWithStatus.message });
});

await app.listen({ host: config.host, port: config.port });
