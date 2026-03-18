import fs from "node:fs/promises";
import path from "node:path";
import fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import { createAuthToken, verifyAuthToken } from "./auth";
import { readBuildId } from "./build-id";
import { loadConfig, resolvePiFaceDir } from "./config";
import { createLoginRateLimiter } from "./login-rate-limit";
import { PiService, type UploadedFile } from "./pi-service";
import { WebPushService } from "./web-push";
import { createWorkspace, listWorkspaces, resolveWorkspace } from "./workspaces";

const config = await loadConfig(resolvePiFaceDir());
const webPush = new WebPushService(config);
await webPush.initialize();
const service = new PiService(config, async (session) => {
  await webPush.notifyAgentCompleted(session);
});

const loginRateLimiter = createLoginRateLimiter();

const app = fastify({
  logger: true,
  trustProxy: true,
  bodyLimit: 1024 * 1024 * 100,
});

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

app.decorateRequest("auth", false);

declare module "fastify" {
  interface FastifyRequest {
    auth: boolean;
  }
}

app.addHook("onRequest", async (request, reply) => {
  request.auth = isAuthenticated(request.cookies[config.cookieName]);

  if (request.url.startsWith("/api") && request.url !== "/api/login" && !request.auth) {
    if (request.url === "/api/bootstrap" || request.url === "/api/version") {
      return;
    }
    reply.code(401).send({ error: "Authentication required" });
  }
});

app.post<{ Body: { username?: string; password?: string } }>(
  "/api/login",
  async (request, reply) => {
    const rateLimitKey = request.ip;
    if (loginRateLimiter.isLimited(rateLimitKey)) {
      reply.code(429).send({ error: "Too many login attempts. Try again in a minute." });
      return;
    }

    if (request.body?.username !== config.username || request.body?.password !== config.password) {
      loginRateLimiter.recordFailure(rateLimitKey);
      reply.code(401).send({ error: "Wrong username or password" });
      return;
    }

    loginRateLimiter.reset(rateLimitKey);
    reply.setCookie(config.cookieName, createAuthToken(config.authSecret), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: request.protocol === "https",
      maxAge: 60 * 60 * 24 * 30,
    });

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
    authUsername: config.username,
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
