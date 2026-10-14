// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify from "fastify";
import { expect, test } from "vite-plus/test";
import { createSite } from "../sites";
import type { AppConfig } from "../config";
import { registerSiteRoutes } from "./sites";

test.each(["/", "/batty", "/nested/app"])(
  "private site redirects retain public base %s behind a prefix-stripping proxy",
  async (baseUrl) => {
    const sitesDir = await mkdtemp(join(tmpdir(), "batty-sites-"));
    const app = fastify();
    const prefix = baseUrl === "/" ? "" : baseUrl;
    try {
      const site = await createSite(sitesDir, baseUrl, "Fixture");
      await writeFile(join(site.directory, "index.html"), '<img src="asset.svg">');
      await writeFile(
        join(site.directory, "asset.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      );
      app.decorateRequest("auth", false);
      app.addHook("onRequest", async (request) => {
        request.auth = request.headers.authorization === "fixture";
      });
      registerSiteRoutes({
        app,
        config: { sitesDir, baseUrl } as AppConfig,
        routePath: (route: string) => route,
      });
      const path = `/sites/${site.descriptor.id}`;
      const preview = site.browserUrl.slice(prefix.length);
      const query = "?batty_preview=1";
      const response = await app.inject({
        url: `${path}/${query}`,
        headers: { authorization: "fixture" },
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(`${site.browserUrl}${query}`);
      const html = await app.inject(`${preview}${query}`);
      expect(html.statusCode).toBe(200);
      expect(html.body).toBe('<img src="asset.svg">');
      const asset = await app.inject(`${preview}asset.svg`);
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-type"]).toBe("image/svg+xml");
      expect(asset.body).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
      for (const url of [path, preview.slice(0, -1)]) {
        const canonical = await app.inject(`${url}${query}`);
        expect(canonical.statusCode).toBe(302);
        expect(canonical.headers.location).toBe(`${prefix}${url}/${query}`);
      }
      const login = await app.inject({ url: `${path}/${query}`, headers: { accept: "text/html" } });
      expect(login.headers.location).toBe(
        `${prefix}/login?returnTo=${encodeURIComponent(`${prefix}${path}/${query}`)}`,
      );
      expect((await app.inject(`${path}/`)).statusCode).toBe(401);
    } finally {
      await app.close();
      await rm(sitesDir, { recursive: true, force: true });
    }
  },
);
