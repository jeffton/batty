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

  function capabilityUrl(siteId: string, accessToken: string, requestPath: string): string {
    const encodedPath = requestPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${routePath("/site-preview")}/${encodeURIComponent(siteId)}/${encodeURIComponent(accessToken)}/${encodedPath}`;
  }

  async function serveSite(
    request: FastifyRequest,
    reply: FastifyReply,
    siteId: string,
    requestPath: string,
    capabilityToken?: string,
  ) {
    const resolved = await resolveSiteFile(config.sitesDir, config.baseUrl, siteId, requestPath);
    const hasCapability = capabilityToken === resolved.accessToken;
    if (capabilityToken !== undefined && !hasCapability) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!resolved.descriptor.public && !request.auth && !hasCapability) {
      if (request.headers.accept?.includes("text/html")) {
        const loginUrl = `${routePath("/login")}?returnTo=${encodeURIComponent(request.url)}`;
        return reply.redirect(loginUrl);
      }
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!resolved.descriptor.public && request.auth && !hasCapability) {
      const queryIndex = request.url.indexOf("?");
      const query = queryIndex === -1 ? "" : request.url.slice(queryIndex);
      return reply.redirect(capabilityUrl(siteId, resolved.accessToken, requestPath) + query);
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

  function withTrailingSlash(requestUrl: string): string {
    const queryIndex = requestUrl.indexOf("?");
    if (queryIndex === -1) return `${requestUrl}/`;
    return `${requestUrl.slice(0, queryIndex)}/${requestUrl.slice(queryIndex)}`;
  }

  app.get<{ Params: { siteId: string } }>(routePath("/sites/:siteId"), (request, reply) =>
    reply.redirect(withTrailingSlash(request.url)),
  );
  app.get<{ Params: { siteId: string; "*": string } }>(
    routePath("/sites/:siteId/*"),
    (request, reply) => serveSite(request, reply, request.params.siteId, request.params["*"]),
  );

  app.get<{ Params: { siteId: string; accessToken: string } }>(
    routePath("/site-preview/:siteId/:accessToken"),
    (request, reply) => reply.redirect(withTrailingSlash(request.url)),
  );
  app.get<{ Params: { siteId: string; accessToken: string } }>(
    routePath("/site-preview/:siteId/:accessToken/"),
    (request, reply) =>
      serveSite(request, reply, request.params.siteId, "", request.params.accessToken),
  );
  app.get<{ Params: { siteId: string; accessToken: string; "*": string } }>(
    routePath("/site-preview/:siteId/:accessToken/*"),
    (request, reply) =>
      serveSite(
        request,
        reply,
        request.params.siteId,
        request.params["*"],
        request.params.accessToken,
      ),
  );
}
