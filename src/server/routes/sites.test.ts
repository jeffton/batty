import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createSite, setSitePublic } from "../sites";
import { registerSiteRoutes } from "./sites";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-site-routes-"));
  roots.push(root);
  const site = await createSite(root, "/batty", "Demo");
  await fs.writeFile(path.join(site.directory, "index.html"), "<h1>Demo</h1>", "utf8");
  await fs.writeFile(path.join(site.directory, "app.js"), "window.ready = true", "utf8");
  await fs.writeFile(
    path.join(site.directory, "active.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><script>window.active=true</script></svg>',
    "utf8",
  );

  const app = Fastify();
  await app.register(cookie);
  app.decorateRequest("auth", false);
  app.addHook("onRequest", async (request) => {
    request.auth = request.headers["x-test-auth"] === "yes";
  });
  registerSiteRoutes({
    app,
    config: { sitesDir: root, baseUrl: "/batty" },
    routePath: (route: string) => `/batty${route}`,
  } as any);
  await app.ready();
  return { app, root, site };
}

describe("site routes", () => {
  it("requires auth for private sites and serves sandboxed HTML", async () => {
    const { app, site } = await fixture();
    expect((await app.inject(site.descriptor.url)).statusCode).toBe(401);

    const response = await app.inject({
      url: site.descriptor.url,
      headers: { "x-test-auth": "yes" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain("sandbox");
    expect(response.headers["content-security-policy"]).not.toContain("allow-same-origin");

    const svg = await app.inject({
      url: `${site.descriptor.url}active.svg`,
      headers: { "x-test-auth": "yes" },
    });
    expect(svg.headers["content-security-policy"]).toContain("sandbox");
    expect(svg.headers["content-security-policy"]).not.toContain("allow-same-origin");
    await app.close();
  });

  it("exchanges the browser capability for an HttpOnly site cookie", async () => {
    const { app, site } = await fixture();
    const entry = await app.inject(site.browserUrl);
    expect(entry.statusCode).toBe(302);
    expect(entry.headers.location).toBe(site.descriptor.url);
    expect(entry.headers["set-cookie"]).toContain("HttpOnly");
    const cookieHeader = String(entry.headers["set-cookie"]).split(";", 1)[0]!;

    const page = await app.inject({ url: site.descriptor.url, headers: { cookie: cookieHeader } });
    expect(page.statusCode).toBe(200);
    const asset = await app.inject({
      url: `${site.descriptor.url}app.js`,
      headers: { cookie: cookieHeader },
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("no-store");
    expect(asset.body).toBe("window.ready = true");
    await app.close();
  });

  it("redirects site roots to their canonical trailing-slash URLs", async () => {
    const { app, site } = await fixture();
    const url = site.descriptor.url.slice(0, -1);
    const response = await app.inject(url);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(site.descriptor.url);
    await app.close();
  });

  it("serves public sites without auth", async () => {
    const { app, root, site } = await fixture();
    await setSitePublic(root, "/batty", site.descriptor.id, true);
    expect((await app.inject(site.descriptor.url)).statusCode).toBe(200);
    await app.close();
  });
});
