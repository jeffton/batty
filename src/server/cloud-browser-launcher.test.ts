// @vitest-environment node
import fastify from "fastify";
import { expect, test, vi } from "vite-plus/test";
import { cloudBrowserAvailable, registerCloudBrowserLauncher } from "./cloud-browser-launcher";
import type { BrowserService } from "./browser-service";

test("launcher is Linux-only and rejects unsupported hosts, cross-origin requests and unknown workspaces", async () => {
  expect(await cloudBrowserAvailable("darwin")).toBe(false);
  expect(await cloudBrowserAvailable("win32")).toBe(false);
  const openCloudBrowser = vi.fn(async () => ({ browserId: "shared-browser" }));
  const browser = { openCloudBrowser } as unknown as BrowserService;
  for (const available of [false, true]) {
    const app = fastify();
    app.addHook("onRequest", async (request, reply) => {
      if (request.headers.authorization !== "test") return reply.code(401).send();
    });
    registerCloudBrowserLauncher(
      app,
      browser,
      "https://batty.example/batty/",
      available,
      async () => ["roy"],
    );
    const open = (workspaceId: string, origin = "https://batty.example", authorized = true) =>
      app.inject({
        method: "POST",
        url: "/api/cloud-browser/open",
        payload: { workspaceId },
        headers: { origin, ...(authorized ? { authorization: "test" } : {}) },
      });
    try {
      expect((await open("roy", undefined, false)).statusCode).toBe(401);
      expect((await open("roy", "https://attacker.example")).statusCode).toBe(403);
      expect((await open("roy")).statusCode).toBe(available ? 200 : 501);
      expect((await open("missing")).statusCode).toBe(available ? 404 : 501);
    } finally {
      await app.close();
    }
  }
  expect(openCloudBrowser).toHaveBeenCalledExactlyOnceWith("workspace:roy");
});
