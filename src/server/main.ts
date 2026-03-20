import fs from "node:fs/promises";
import path from "node:path";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/types";
import fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import { createAuthToken, verifyAuthToken } from "./auth";
import { readBuildId } from "./build-id";
import { loadConfig, resolveBattyDir } from "./config";
import { createLoginRateLimiter } from "./login-rate-limit";
import { formatSetupCode, PasskeyAuthService } from "./passkeys";
import type { WorkspaceSnapshot } from "@/shared/types";
import { CronService } from "./cron";
import { PiService, type UploadedFile } from "./pi-service";
import { WebPushService } from "./web-push";
import { createWorkspace, listWorkspaces, resolveWorkspace } from "./workspaces";

const config = await loadConfig(resolveBattyDir());
const passkeys = new PasskeyAuthService(config.battyDir, config.authSecret);
const bootstrapSetupCode = await passkeys.initialize();
const webPush = new WebPushService(config);
await webPush.initialize();
const cronService = new CronService(config);
const workspaceSubscribers = new Map<string, Set<(snapshot: WorkspaceSnapshot) => void>>();

async function workspaceSnapshot(workspaceId: string): Promise<WorkspaceSnapshot> {
  const workspaces = await listWorkspaces(config);
  const workspace = resolveWorkspace(workspaces, workspaceId);
  return {
    workspaceId,
    sessions: await service.listSessionSummaries(workspace),
    cronJobs: cronService.listJobs(workspaceId),
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

const service = new PiService(
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
  run: async (job) => {
    const workspaces = await listWorkspaces(config);
    const workspace = resolveWorkspace(workspaces, job.workspaceId);
    return service.runCronJobSession({
      workspace,
      prompt: job.prompt,
      model: job.model,
      thinkingLevel: job.thinkingLevel,
    });
  },
});
await cronService.initialize();

const authAttemptLimiter = createLoginRateLimiter();

const app = fastify({
  logger: true,
  trustProxy: true,
  bodyLimit: 1024 * 1024 * 100,
});

if (bootstrapSetupCode) {
  console.log(`Setup code: ${formatSetupCode(bootstrapSetupCode.code)}`);
  console.log(`Expires at: ${new Date(bootstrapSetupCode.expiresAt).toISOString()}`);
}

await fs.mkdir(config.uploadsDir, { recursive: true });

await app.register(cookie);
await app.register(multipart);
const hasBuiltClient = await fs
  .access(path.join(config.publicDir, "index.html"))
  .then(() => true)
  .catch(() => false);
const buildId = await readBuildId(config.publicDir);

if (hasBuiltClient) {
  await app.register(staticFiles, {
    root: config.publicDir,
    prefix: "/",
  });
}

function isAuthenticated(token?: string): boolean {
  return verifyAuthToken(config.authSecret, token);
}

function shouldServeClientApp(url: string): boolean {
  const pathname = url.split("?", 1)[0]?.split("#", 1)[0] ?? "/";
  if (pathname.startsWith("/api")) {
    return false;
  }
  if (pathname === "/") {
    return true;
  }
  return path.extname(pathname) === "";
}

function allowUnauthenticatedApi(pathname: string): boolean {
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

function requestOrigin(request: FastifyRequest): string {
  const header = request.headers["x-forwarded-host"] ?? request.headers.host;
  const host = (Array.isArray(header) ? header[0] : header)?.split(",", 1)[0]?.trim();
  if (!host) {
    throw new Error("Missing host header");
  }
  return new URL(`${request.protocol}://${host}`).origin;
}

function requestRpId(request: FastifyRequest): string {
  return new URL(requestOrigin(request)).hostname;
}

function setAuthCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.setCookie(config.cookieName, createAuthToken(config.authSecret), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: request.protocol === "https",
    maxAge: 60 * 60 * 24 * 30,
  });
}

function unauthenticatedAuthStatus() {
  return {
    passkeyCount: 0,
    passkeyLoginAvailable: false,
    registrationOpen: false,
    setupRequired: false,
  };
}

app.decorateRequest("auth", false);

declare module "fastify" {
  interface FastifyRequest {
    auth: boolean;
  }
}

app.addHook("onRequest", async (request, reply) => {
  request.auth = isAuthenticated(request.cookies[config.cookieName]);

  if (request.url.startsWith("/api") && !allowUnauthenticatedApi(request.url) && !request.auth) {
    reply.code(401).send({ error: "Authentication required" });
  }
});

app.post("/api/auth/login/options", async (request) => {
  return passkeys.beginAuthentication(requestOrigin(request), requestRpId(request));
});

app.post<{ Body: { requestId?: string; response?: AuthenticationResponseJSON } }>(
  "/api/auth/login/verify",
  async (request, reply) => {
    const rateLimitKey = "login";
    if (authAttemptLimiter.isLimited(rateLimitKey)) {
      reply.code(429).send({ error: "Too many sign-in attempts. Try again in a minute." });
      return;
    }
    if (!request.body?.requestId || !request.body.response) {
      reply.code(400).send({ error: "Missing passkey sign-in response" });
      return;
    }

    try {
      await passkeys.finishAuthentication(
        request.body.requestId,
        request.body.response,
        requestOrigin(request),
        requestRpId(request),
      );
    } catch (error) {
      authAttemptLimiter.recordFailure(rateLimitKey);
      throw error;
    }

    authAttemptLimiter.reset(rateLimitKey);
    setAuthCookie(request, reply);
    reply.send({ ok: true });
  },
);

app.post<{ Body: { setupCode?: string } }>("/api/auth/register/options", async (request, reply) => {
  const rateLimitKey = "register";
  if (authAttemptLimiter.isLimited(rateLimitKey)) {
    reply.code(429).send({ error: "Too many setup code attempts. Try again in a minute." });
    return;
  }
  if (!request.body?.setupCode) {
    reply.code(400).send({ error: "Missing setup code" });
    return;
  }

  try {
    return await passkeys.beginRegistration(
      request.body.setupCode,
      requestOrigin(request),
      requestRpId(request),
    );
  } catch (error) {
    authAttemptLimiter.recordFailure(rateLimitKey);
    throw error;
  }
});

app.post<{ Body: { requestId?: string; response?: RegistrationResponseJSON } }>(
  "/api/auth/register/verify",
  async (request, reply) => {
    const rateLimitKey = "register";
    if (authAttemptLimiter.isLimited(rateLimitKey)) {
      reply.code(429).send({ error: "Too many setup code attempts. Try again in a minute." });
      return;
    }
    if (!request.body?.requestId || !request.body.response) {
      reply.code(400).send({ error: "Missing passkey registration response" });
      return;
    }

    try {
      await passkeys.finishRegistration(
        request.body.requestId,
        request.body.response,
        requestOrigin(request),
        requestRpId(request),
      );
    } catch (error) {
      authAttemptLimiter.recordFailure(rateLimitKey);
      throw error;
    }

    authAttemptLimiter.reset(rateLimitKey);
    setAuthCookie(request, reply);
    reply.send({ ok: true });
  },
);

app.post("/api/logout", async (_request, reply) => {
  reply.clearCookie(config.cookieName, { path: "/" });
  reply.send({ ok: true });
});

app.get("/api/bootstrap", async (request) => {
  const authenticated = request.auth;
  return {
    authenticated,
    auth: authenticated ? await passkeys.getStatus() : unauthenticatedAuthStatus(),
    buildId,
    workspaces: authenticated ? await listWorkspaces(config) : [],
    models: authenticated ? await service.listModels() : [],
  };
});

app.get("/api/version", async () => ({ buildId }));

app.get("/api/push/public-key", async () => ({ publicKey: webPush.getPublicKey() }));

app.post<{ Body: { subscription?: PushSubscriptionJSON } }>(
  "/api/push/subscriptions",
  async (request) => {
    if (!request.body?.subscription) {
      throw new Error("Missing push subscription");
    }

    await webPush.upsertSubscription(request.body.subscription);
    return { ok: true };
  },
);

app.post<{ Body: { endpoint?: string } }>("/api/push/subscriptions/delete", async (request) => {
  if (!request.body?.endpoint) {
    throw new Error("Missing push subscription endpoint");
  }

  await webPush.removeSubscription(request.body.endpoint);
  return { ok: true };
});

app.get("/api/workspaces", async () => {
  return listWorkspaces(config);
});

app.post<{ Body: { name?: string } }>("/api/workspaces", async (request) => {
  return createWorkspace(config, request.body?.name ?? "");
});

app.get<{ Params: { workspaceId: string } }>(
  "/api/workspaces/:workspaceId/sessions",
  async (request) => {
    const workspaces = await listWorkspaces(config);
    const workspace = resolveWorkspace(workspaces, request.params.workspaceId);
    return service.listSessionSummaries(workspace);
  },
);

app.get<{ Params: { workspaceId: string } }>(
  "/api/workspaces/:workspaceId/events",
  async (request, reply) => {
    const snapshot = await workspaceSnapshot(request.params.workspaceId);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const send = (payload: WorkspaceSnapshot) => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const subscribers = workspaceSubscribers.get(request.params.workspaceId) ?? new Set();
    subscribers.add(send);
    workspaceSubscribers.set(request.params.workspaceId, subscribers);
    send(snapshot);

    const heartbeat = setInterval(() => {
      reply.raw.write(": keep-alive\n\n");
    }, 15000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      const current = workspaceSubscribers.get(request.params.workspaceId);
      current?.delete(send);
      if (current && current.size === 0) {
        workspaceSubscribers.delete(request.params.workspaceId);
      }
      reply.raw.end();
    });
  },
);

app.get<{ Params: { workspaceId: string } }>(
  "/api/workspaces/:workspaceId/cron-jobs",
  async (request) => {
    const workspaces = await listWorkspaces(config);
    const workspace = resolveWorkspace(workspaces, request.params.workspaceId);
    return cronService.listJobs(workspace.id);
  },
);

app.post<{
  Body: {
    workspaceId?: string;
    prompt?: string;
    model?: string;
    thinkingLevel?: string;
    schedule?: {
      kind?: string;
      at?: string;
      in?: string;
      every?: string;
      expression?: string;
      timezone?: string;
    };
  };
}>("/api/cron-jobs", async (request) => {
  return cronService.createJob({
    workspaceId: request.body?.workspaceId ?? "",
    prompt: request.body?.prompt ?? "",
    model: request.body?.model ?? "",
    thinkingLevel: request.body?.thinkingLevel ?? "",
    schedule: (request.body?.schedule ?? {}) as never,
  });
});

app.patch<{
  Params: { jobId: string };
  Body: {
    workspaceId?: string;
    prompt?: string;
    model?: string;
    thinkingLevel?: string;
    schedule?: {
      kind?: string;
      at?: string;
      in?: string;
      every?: string;
      expression?: string;
      timezone?: string;
    };
  };
}>("/api/cron-jobs/:jobId", async (request) => {
  return cronService.updateJob(request.params.jobId, {
    workspaceId: request.body?.workspaceId,
    prompt: request.body?.prompt,
    model: request.body?.model,
    thinkingLevel: request.body?.thinkingLevel,
    schedule: request.body?.schedule as never,
  });
});

app.delete<{ Params: { jobId: string } }>("/api/cron-jobs/:jobId", async (request) => {
  return cronService.deleteJob(request.params.jobId);
});

app.post<{ Body: { workspaceId: string } }>("/api/sessions", async (request) => {
  const workspaces = await listWorkspaces(config);
  const workspace = resolveWorkspace(workspaces, request.body.workspaceId);
  return service.createSession(workspace);
});

app.post<{ Body: { workspaceId: string; sessionPath: string } }>(
  "/api/sessions/open",
  async (request) => {
    const workspaces = await listWorkspaces(config);
    const workspace = resolveWorkspace(workspaces, request.body.workspaceId);
    return service.openSession(workspace, request.body.sessionPath);
  },
);

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request) => {
  return service.getState(request.params.sessionId);
});

app.post<{ Params: { sessionId: string }; Body: { modelId: string } }>(
  "/api/sessions/:sessionId/model",
  async (request) => {
    return service.setModel(request.params.sessionId, request.body.modelId);
  },
);

app.post<{ Params: { sessionId: string }; Body: { thinkingLevel: string } }>(
  "/api/sessions/:sessionId/thinking",
  async (request) => {
    return service.setThinkingLevel(request.params.sessionId, request.body.thinkingLevel);
  },
);

app.post<{ Params: { sessionId: string } }>(
  "/api/sessions/:sessionId/prompt",
  async (request, reply) => {
    const files: UploadedFile[] = [];
    let text = "";
    let streamingBehavior: "steer" | "followUp" | undefined;

    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === "file") {
        files.push({
          filename: part.filename,
          data: await part.toBuffer(),
        });
      } else if (part.fieldname === "text") {
        text = String(part.value ?? "");
      } else if (part.fieldname === "streamingBehavior") {
        const value = String(part.value ?? "");
        if (value === "steer" || value === "followUp") {
          streamingBehavior = value;
        }
      }
    }

    await service.prompt(request.params.sessionId, text, files, streamingBehavior);
    reply.send({ ok: true });
  },
);

app.post<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/abort", async (request) => {
  await service.abort(request.params.sessionId);
  return { ok: true };
});

app.get<{
  Params: { sessionId: string };
  Querystring: { workspaceId?: string; sessionPath?: string };
}>("/api/sessions/:sessionId/events", async (request, reply) => {
  if (!service.hasSession(request.params.sessionId)) {
    const { workspaceId, sessionPath } = request.query;
    if (!workspaceId || !sessionPath) {
      reply.code(404).send({ error: `Unknown session: ${request.params.sessionId}` });
      return;
    }

    const workspaces = await listWorkspaces(config);
    const workspace = resolveWorkspace(workspaces, workspaceId);
    const restoredSession = await service.openSession(workspace, sessionPath);
    if (restoredSession.sessionId !== request.params.sessionId) {
      reply.code(409).send({ error: `Session id mismatch: ${request.params.sessionId}` });
      return;
    }
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const send = (payload: unknown) => {
    reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const unsubscribe = service.subscribe(request.params.sessionId, send);
  const heartbeat = setInterval(() => {
    reply.raw.write(": keep-alive\n\n");
  }, 15000);

  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    reply.raw.end();
  });
});

app.get("/healthz", async () => ({ ok: true }));

app.setNotFoundHandler((request, reply) => {
  if (hasBuiltClient && shouldServeClientApp(request.url)) {
    return reply.sendFile("index.html");
  }

  reply.code(404).send({ error: "Not found" });
});

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  const statusCode =
    "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
  reply.code(statusCode).send({ error: error.message });
});

await app.listen({ host: config.host, port: config.port });
