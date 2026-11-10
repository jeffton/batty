// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fastify from "fastify";
import { chromium } from "patchright";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { expect, test } from "vite-plus/test";
import { registerBrowserErrorRoutes } from "@/server/browser-errors";
import { createOwnerRpcHandler, type OwnerRpcServices } from "@/server/owner-rpc";
import type { Runtime } from "@/server/runtime";
import { RpcError } from "@/shared/rpc-channel";
import { fixtureOperation, setFixtureRpcHandler } from "../test/socket-fixture";

test("browser rejection and caught upload failure reach authenticated server without content", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-browser-errors-"));
  const file = path.join(dir, "browser-errors.json");
  const backend = fastify();
  let telemetryWrites = 0;
  backend.decorateRequest("auth", false);
  backend.addHook("onRequest", async (req) => {
    req.auth = req.headers.cookie === "fixture=authenticated";
  });
  const reportBrowserError = registerBrowserErrorRoutes(backend, file);
  backend.addContentTypeParser(/^multipart\/form-data/, (_req, _body, done) =>
    done(null, undefined),
  );
  backend.get("/api/bootstrap", async () => ({ authenticated: true }));
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
  setFixtureRpcHandler(
    server,
    createOwnerRpcHandler(
      { config: {}, tools: {} } as unknown as Runtime,
      {
        reportBrowserError: async (report) => {
          await reportBrowserError(report);
          telemetryWrites++;
        },
      } as OwnerRpcServices,
    ),
  );
  await server.listen();
  const url = server.resolvedUrls!.local[0]!;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies([{ name: "fixture", value: "authenticated", url }]);
  const page = await context.newPage();
  let uploaded = "";
  await fixtureOperation(server, page, "main.submit", async (input, rpc) => {
    expect(input.files).toEqual([{ name: "PRIVATE.jpg", type: "", size: 13 }]);
    const reader = rpc.body!.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value);
    }
    uploaded = Buffer.concat(chunks).toString();
    throw new RpcError("LIMIT", "PRIVATE prompt token=secret");
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
    await expect.poll(() => telemetryWrites, { timeout: 5000 }).toBe(5);
    expect(uploaded).toBe("PRIVATE bytes");
    const reports = JSON.parse(await fs.readFile(file, "utf8"));
    expect(reports.map((r: any) => r.stage).sort()).toEqual([
      "cache-write",
      "submit",
      "unhandledrejection",
      "vue",
      "window",
    ]);
    expect(reports.find((r: any) => r.stage === "submit")).toMatchObject({
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
