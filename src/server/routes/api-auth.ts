import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyAuthToken } from "../auth";

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

export function registerApiAuth(
  app: FastifyInstance,
  config: { authSecret: string; cookieName: string },
  authenticateNode: (request: FastifyRequest, reply: FastifyReply) => FastifyReply | undefined,
) {
  app.decorateRequest("auth", false);
  app.addHook("onRequest", async (request, reply) => {
    request.auth = verifyAuthToken(config.authSecret, request.cookies[config.cookieName]);
    const route = request.routeOptions.url;
    if (!route?.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    if (route.startsWith("/api/node/")) return authenticateNode(request, reply);
    if (!publicApis.has(route) && !request.auth)
      return reply.code(401).send({ error: "Authentication required" });
  });
}
