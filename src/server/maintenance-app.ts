import fs from "node:fs/promises";
import path from "node:path";
import fastify from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import { Type } from "typebox";
import { verifyAuthToken } from "./auth";
import { createLoginRateLimiter } from "./login-rate-limit";
import { createMaintenanceChat, type MaintenanceMessage } from "./maintenance-chat";
import { readMaintenance } from "./maintenance-state";
import { readStoredOptions } from "./options";
import { PasskeyAuthService } from "./passkeys";
import { registerLoginRoutes, requestOrigin } from "./routes/auth";

export async function createMaintenanceApp(
  root: string,
  publicDir: string,
  mainUrl: string,
  chat = createMaintenanceChat(root, mainUrl),
) {
  const options = await readStoredOptions(root);
  if (!options?.authSecret)
    throw new Error("Maintenance requires an initialized Batty installation");
  if (options.baseUrl && options.baseUrl !== "/")
    throw new Error("The maintenance gateway requires a root web origin");
  const config = {
    authSecret: options.authSecret,
    cookieName: "batty2-auth",
    baseUrl: "/" as const,
  };
  const shell = (await fs.readFile(path.join(publicDir, "maintenance.html"), "utf8")).replace(
    "<head>",
    '<head><base href="/maintenance/">',
  );
  const app = fastify({ trustProxy: ["127.0.0.1", "::1"], forceCloseConnections: true });
  await app.register(cookie);

  const prefix = "/api/maintenance";
  const isOwner = (token?: string) => verifyAuthToken(config.authSecret, token);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    if (
      request.method === "POST" &&
      request.url.startsWith(`${prefix}/`) &&
      request.headers.origin !== requestOrigin(request)
    )
      return reply.code(403).send({ error: "Same-origin request required" });
  });
  const login = app.register(async (scope) => {
    scope.addHook("onRequest", async (_request, reply) => {
      if (!(await readMaintenance(root))) return reply.code(404).send();
    });
    registerLoginRoutes({
      app: scope,
      config,
      passkeys: new PasskeyAuthService(root, config.authSecret),
      authAttemptLimiter: createLoginRateLimiter(),
      routePath: (route) => prefix + route.slice(4),
    });
  });
  await login;
  app.get("/healthz", () => ({ maintenance: true }));
  app.get(`${prefix}/status`, async (request) => {
    const state = await readMaintenance(root);
    if (!state) return { active: false };
    if (!isOwner(request.cookies[config.cookieName])) return { active: true, authenticated: false };
    const { id, phase, message, progress, startedAt, updatedAt, model } = state;
    return {
      active: true,
      authenticated: true,
      id,
      phase,
      message,
      progress,
      startedAt,
      updatedAt,
      model: `${model.provider}/${model.modelId}`,
    };
  });

  app.post<{ Body: { id: string; messages: MaintenanceMessage[] } }>(
    `${prefix}/chat`,
    {
      schema: {
        body: Type.Object({
          id: Type.String(),
          messages: Type.Array(
            Type.Object({
              role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
              text: Type.String({ minLength: 1 }),
            }),
            { minItems: 1 },
          ),
        }),
      },
    },
    async (request, reply) => {
      const token = request.cookies[config.cookieName];
      if (!isOwner(token)) return reply.code(401).send({ error: "Sign in with your passkey" });
      const state = await readMaintenance(root);
      if (!state || state.id !== request.body.id)
        return reply.code(409).send({ error: "This maintenance session ended" });
      const { messages } = request.body;
      if (messages.at(-1)?.role !== "user")
        return reply.code(400).send({ error: "A question is required" });
      const abort = new AbortController();
      const disconnect = () => abort.abort();
      reply.raw.once("close", disconnect);
      try {
        const answer = await chat.answer(state.id, state.model, messages, abort.signal);
        if (!isOwner(token))
          return reply.code(401).send({ error: "Sign in again with your passkey" });
        if ((await readMaintenance(root))?.id !== state.id)
          return reply.code(409).send({ error: "This maintenance session ended" });
        return { answer };
      } catch (error) {
        if (abort.signal.aborted) return;
        request.log.warn({ name: (error as Error)?.name }, "Maintenance chat failed");
        return reply
          .code(502)
          .send({ error: "The main model could not answer during maintenance." });
      } finally {
        reply.raw.off("close", disconnect);
      }
    },
  );
  await app.register(staticFiles, {
    root: path.join(publicDir, "assets"),
    prefix: "/maintenance/assets/",
  });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/") || !["GET", "HEAD"].includes(request.method))
      return reply
        .code(503)
        .header("X-Batty-Maintenance", "1")
        .send({ error: "Batty is under maintenance" });
    if (!(await readMaintenance(root))) return reply.redirect("/");
    return reply
      .code(503)
      .header("X-Batty-Maintenance", "1")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
      )
      .type("text/html")
      .send(shell);
  });
  app.setErrorHandler((error, request, reply) => {
    const failure = error as Error & { statusCode?: number };
    request.log.warn({ name: failure.name }, "Maintenance request failed");
    reply.code(failure.statusCode ?? 500).send({ error: "Maintenance request failed" });
  });
  app.addHook("onClose", async () => chat.settleCredentials());
  return app;
}
