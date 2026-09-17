import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveSiteFile, setSitePublic } from "../sites";
import type { RouteContext } from "./context";

export function registerSiteRoutes({ app, config, routePath }: RouteContext): void {
  app.patch<{
    Params: { siteId: string };
    Body: { public?: unknown };
  }>(routePath("/api/sites/:siteId"), async (request, reply) => {
    if (typeof request.body?.public !== "boolean") {
      return reply.code(400).send({ error: "public must be a boolean" });
    }
    return setSitePublic(
      config.sitesDir,
      config.baseUrl,
      request.params.siteId,
      request.body.public,
    );
  });

  async function serveSite(
    request: FastifyRequest,
    reply: FastifyReply,
    siteId: string,
    requestPath: string,
  ) {
    const resolved = await resolveSiteFile(config.sitesDir, config.baseUrl, siteId, requestPath);
    const agentCookieName = `batty-site-${siteId}`;
    const hasAgentAccess = request.cookies[agentCookieName] === resolved.accessToken;
    if (!resolved.descriptor.public && !request.auth && !hasAgentAccess) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const stats = await fs.stat(resolved.filePath);
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Type", resolved.mimeType);
    reply.header("Content-Length", String(stats.size));
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header(
      "Content-Security-Policy",
      "sandbox allow-downloads allow-forms allow-modals allow-popups allow-scripts",
    );
    return reply.send(createReadStream(resolved.filePath));
  }

  app.get<{ Params: { siteId: string } }>(routePath("/sites/:siteId"), (request, reply) =>
    reply.redirect(`${request.url.split("?", 1)[0]}/`),
  );
  app.get<{ Params: { siteId: string; "*": string } }>(
    routePath("/sites/:siteId/*"),
    (request, reply) => serveSite(request, reply, request.params.siteId, request.params["*"]),
  );

  app.get<{ Params: { siteId: string; accessToken: string } }>(
    routePath("/site-preview/:siteId/:accessToken"),
    (request, reply) => reply.redirect(`${request.url.split("?", 1)[0]}/`),
  );
  app.get<{ Params: { siteId: string; accessToken: string } }>(
    routePath("/site-preview/:siteId/:accessToken/"),
    async (request, reply) => {
      const resolved = await resolveSiteFile(
        config.sitesDir,
        config.baseUrl,
        request.params.siteId,
        "",
      );
      if (request.params.accessToken !== resolved.accessToken) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      reply.setCookie(`batty-site-${request.params.siteId}`, resolved.accessToken, {
        httpOnly: true,
        sameSite: "strict",
        path: resolved.descriptor.url,
      });
      return reply.redirect(resolved.descriptor.url);
    },
  );
}
