import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fastify from "fastify";
import { describe, expect, it } from "vite-plus/test";
import { registerBrowserErrorRoutes } from "./browser-errors";

const report = {
  timestamp: new Date().toISOString(),
  correlationId: "test-id",
  buildId: "dev",
  stage: "submit",
  browser: "WebKit",
  platform: "iOS",
  errorName: "Error",
  message: "token=secret user prompt",
  stack: "Error: private\n at https://example.com/assets/main.js?token=secret:10:20",
  status: 413,
  hasFiles: true,
};

describe("browser error endpoint", () => {
  it("expires old reports and caps the persistent log", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-errors-retention-"));
    const file = path.join(dir, "browser-errors.json");
    const old = { ...report, receivedAt: new Date(Date.now() - 8 * 86400000).toISOString() };
    await fs.writeFile(
      file,
      JSON.stringify([
        old,
        ...Array.from({ length: 210 }, (_, n) => ({
          ...report,
          correlationId: `seed-${n}`,
          receivedAt: new Date().toISOString(),
        })),
      ]),
    );
    const app = fastify();
    app.decorateRequest("auth", true);
    registerBrowserErrorRoutes(app, file);
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/browser-errors",
            headers: { origin: "http://localhost:80" },
            payload: report,
          })
        ).statusCode,
      ).toBe(204);
      const stored = JSON.parse(await fs.readFile(file, "utf8"));
      expect(stored).toHaveLength(200);
      expect(stored.every((r: any) => Date.parse(r.receivedAt) > Date.now() - 86400000)).toBe(true);
      expect(stored.at(-1).correlationId).toBe("test-id");
      if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await app.close();
    }
  });
  it("requires authentication/origin and bounds, sanitizes and deduplicates stored reports", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-errors-"));
    const app = fastify();
    app.decorateRequest("auth", false);
    app.addHook("onRequest", async (req) => {
      req.auth = req.headers.authorization === "fixture";
    });
    const file = path.join(dir, "browser-errors.json");
    registerBrowserErrorRoutes(app, file);
    const send = (
      body: object,
      headers = { authorization: "fixture", origin: "http://localhost:80" },
    ) => app.inject({ method: "POST", url: "/api/browser-errors", headers, payload: body });
    try {
      expect(
        (await send(report, { authorization: "", origin: "http://localhost:80" })).statusCode,
      ).toBe(401);
      expect(
        (await send(report, { authorization: "fixture", origin: "https://evil.test" })).statusCode,
      ).toBe(403);
      expect((await send({ ...report, stack: "x".repeat(9000) })).statusCode).toBe(413);
      expect((await send(report)).statusCode).toBe(204);
      expect((await send(report)).statusCode).toBe(204);
      const stored = JSON.parse(await fs.readFile(file, "utf8"));
      expect(stored).toHaveLength(1);
      expect(stored[0].message).toBe("Error details redacted");
      expect(stored[0].stack).toBe("/assets/main.js:10:20");
      expect(JSON.stringify(stored)).not.toContain("secret");
      expect(stored[0].status).toBe(413);
      for (let n = 0; n < 19; n++) await send({ ...report, status: 500 + n });
      expect((await send({ ...report, status: 599 })).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
