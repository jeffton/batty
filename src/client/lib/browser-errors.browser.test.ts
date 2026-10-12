// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fastify from "fastify";
import { chromium } from "patchright";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { expect, test } from "vite-plus/test";
import { registerBrowserErrorRoutes } from "@/server/browser-errors";

test("browser rejection and caught upload failure reach authenticated server without content", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-browser-errors-"));
  const file = path.join(dir, "browser-errors.json");
  const backend = fastify();
  backend.decorateRequest("auth", false);
  backend.addHook("onRequest", async (req) => {
    req.auth = req.headers.cookie === "fixture=authenticated";
  });
  registerBrowserErrorRoutes(backend, file);
  backend.addContentTypeParser(/^multipart\/form-data/, (_req, _body, done) =>
    done(null, undefined),
  );
  backend.get("/api/bootstrap", async () => ({ authenticated: true }));
  backend.post("/api/main/prompt", async (_req, reply) =>
    reply.code(413).send({ error: "PRIVATE prompt token=secret" }),
  );
  await backend.listen({ host: "127.0.0.1", port: 0 });
  const address = backend.server.address() as { port: number };
  const server = await createBrowserFixtureServer("src/client/lib/BrowserErrors.fixture.html", {
    resolve: { alias: { "@": path.resolve("src") } },
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: { "/api": { target: `http://127.0.0.1:${address.port}`, changeOrigin: false } },
    },
  });
  await server.listen();
  const url = server.resolvedUrls!.local[0]!;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies([{ name: "fixture", value: "authenticated", url }]);
  const page = await context.newPage();
  const telemetryStatuses: number[] = [];
  page.on("response", (response) => {
    if (response.url().endsWith("/api/browser-errors")) telemetryStatuses.push(response.status());
  });
  try {
    await page.goto(`${url}src/client/lib/BrowserErrors.fixture.html`);
    await page.waitForFunction(() => Boolean((window as any).diagnosticsFixture));
    await page.evaluate(
      () => {
        setTimeout(() => {
          void Promise.reject(new TypeError("Load failed"));
        }, 0);
      },
      undefined,
      undefined,
      false,
    );
    const caught = await page.evaluate(
      async () => {
        try {
          await (window as any).diagnosticsFixture.submitMainPrompt(
            "prompt",
            "PRIVATE prompt",
            [new File(["PRIVATE bytes"], "PRIVATE.jpg")],
            "receipt",
          );
        } catch (error) {
          return (error as Error).message;
        }
      },
      undefined,
      undefined,
      false,
    );
    expect(caught).toBe("PRIVATE prompt token=secret");
    await page.evaluate(
      async () => {
        setTimeout(() => {
          throw new ReferenceError("PRIVATE window failure");
        }, 0);
        (window as any).diagnosticsFixture.app.config.errorHandler(
          new TypeError("PRIVATE Vue failure"),
        );
      },
      undefined,
      undefined,
      false,
    );
    await page.evaluate(
      () => {
        (window as any).diagnosticsFixture.reportBrowserError(
          new Error("Cache transaction aborted: write"),
          "cache-write",
        );
      },
      undefined,
      undefined,
      false,
    );
    // Wait for writes to finish before reading: Windows cannot replace a file
    // while a polling reader holds it open.
    await expect
      .poll(() => telemetryStatuses, { timeout: 5000 })
      .toEqual([204, 204, 204, 204, 204]);
    const reports = JSON.parse(await fs.readFile(file, "utf8"));
    expect(reports.map((r: any) => r.stage).sort()).toEqual([
      "cache-write",
      "submit",
      "unhandledrejection",
      "vue",
      "window",
    ]);
    expect(reports.find((r: any) => r.stage === "submit")).toMatchObject({
      status: 413,
      hasFiles: true,
      buildId: "dev",
    });
    expect(reports.find((r: any) => r.stage === "cache-write")).toMatchObject({
      message: "Cache transaction aborted: write",
      errorName: "Error",
    });
    expect(JSON.stringify(reports)).not.toMatch(/PRIVATE|secret|receipt/);
    expect(reports.every((r: any) => /^[a-f0-9-]{36}$/.test(r.correlationId))).toBe(true);
  } finally {
    await browser.close();
    await closeBrowserFixtureServer(server);
    await backend.close();
  }
}, 30_000);
