import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { createAuthToken } from "../auth";
import type { RouteContext } from "./context";

export function requestOrigin(request: FastifyRequest): string {
  return new URL(`${request.protocol}://${request.host}`).origin;
}

export function requestRpId(request: FastifyRequest): string {
  return new URL(requestOrigin(request)).hostname;
}

function authRateLimitKey(
  request: FastifyRequest,
  flow: "login-options" | "login" | "register",
): string {
  return `${flow}:${request.ip}`;
}

function setAuthCookie(context: RouteContext, request: FastifyRequest, reply: FastifyReply): void {
  reply.setCookie(context.config.cookieName, createAuthToken(context.config.authSecret), {
    httpOnly: true,
    sameSite: "lax",
    path: context.config.baseUrl,
    secure: request.protocol === "https",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function registerAuthRoutes(context: RouteContext): void {
  const { app, passkeys, authAttemptLimiter, routePath, config } = context;

  app.post(routePath("/api/auth/login/options"), async (request, reply) => {
    const rateLimitKey = authRateLimitKey(request, "login-options");
    if (authAttemptLimiter.isLimited(rateLimitKey)) {
      reply.code(429).send({ error: "Too many sign-in attempts. Try again in a minute." });
      return;
    }
    authAttemptLimiter.recordFailure(rateLimitKey);
    return passkeys.beginAuthentication(requestOrigin(request), requestRpId(request));
  });

  app.post<{ Body: { requestId?: string; response?: AuthenticationResponseJSON } }>(
    routePath("/api/auth/login/verify"),
    async (request, reply) => {
      const rateLimitKey = authRateLimitKey(request, "login");
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
      authAttemptLimiter.reset(authRateLimitKey(request, "login-options"));
      setAuthCookie(context, request, reply);
      reply.send({ ok: true });
    },
  );

  app.post<{ Body: { setupCode?: string } }>(
    routePath("/api/auth/register/options"),
    async (request, reply) => {
      const rateLimitKey = authRateLimitKey(request, "register");
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
    },
  );

  app.post<{ Body: { requestId?: string; response?: RegistrationResponseJSON } }>(
    routePath("/api/auth/register/verify"),
    async (request, reply) => {
      const rateLimitKey = authRateLimitKey(request, "register");
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
      setAuthCookie(context, request, reply);
      reply.send({ ok: true });
    },
  );

  app.post(routePath("/api/logout"), async (_request, reply) => {
    reply.clearCookie(config.cookieName, { path: config.baseUrl });
    reply.send({ ok: true });
  });
}
