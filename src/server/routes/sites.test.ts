import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  it("requires auth for private sites and redirects authenticated access to a capability URL", async () => {
    const { app, site } = await fixture();
    expect((await app.inject(site.descriptor.url)).statusCode).toBe(401);

    const response = await app.inject({
      url: `${site.descriptor.url}?view=full`,
      headers: { "x-test-auth": "yes" },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${site.browserUrl}?view=full`);

    const page = await app.inject(site.browserUrl);
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-security-policy"]).toContain("sandbox");
    expect(page.headers["content-security-policy"]).not.toContain("allow-same-origin");

    const svg = await app.inject(`${site.browserUrl}active.svg`);
    expect(svg.headers["content-security-policy"]).toContain("sandbox");
    expect(svg.headers["content-security-policy"]).not.toContain("allow-same-origin");
    await app.close();
  });

  it("redirects unauthenticated browser navigation to login and preserves the site URL", async () => {
    const { app, site } = await fixture();
    const response = await app.inject({
      url: `${site.descriptor.url}?view=full`,
      headers: { accept: "text/html,application/xhtml+xml" },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      `/batty/login?returnTo=${encodeURIComponent(`${site.descriptor.url}?view=full`)}`,
    );
    await app.close();
  });

  it("serves page assets directly through the browser capability", async () => {
    const { app, site } = await fixture();
    const page = await app.inject(site.browserUrl);
    expect(page.statusCode).toBe(200);
    expect(page.headers["set-cookie"]).toBeUndefined();

    const asset = await app.inject(`${site.browserUrl}app.js`);
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("no-store");
    expect(asset.body).toBe("window.ready = true");

    const invalidTokenUrl = site.browserUrl.replace(/[^/]+\/$/, "invalid/");
    expect((await app.inject(`${invalidTokenUrl}app.js`)).statusCode).toBe(401);
    await app.close();
  });

  it("redirects site roots to their canonical trailing-slash URLs and preserves queries", async () => {
    const { app, site } = await fixture();
    const siteUrl = site.descriptor.url.slice(0, -1);
    const response = await app.inject(`${siteUrl}?view=full`);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${site.descriptor.url}?view=full`);

    const browserUrl = site.browserUrl.slice(0, -1);
    const capabilityResponse = await app.inject(`${browserUrl}?view=full`);
    expect(capabilityResponse.statusCode).toBe(302);
    expect(capabilityResponse.headers.location).toBe(`${site.browserUrl}?view=full`);
    await app.close();
  });

  it("serves public sites without auth", async () => {
    const { app, root, site } = await fixture();
    await setSitePublic(root, "/batty", site.descriptor.id, true);
    expect((await app.inject(site.descriptor.url)).statusCode).toBe(200);
    await app.close();
  });
});
