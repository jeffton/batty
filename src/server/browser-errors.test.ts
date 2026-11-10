import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fastify from "fastify";
import { describe, expect, it } from "vite-plus/test";
import { createBrowserErrorReporter } from "./browser-errors";

const report: import("@/shared/browser-errors").BrowserErrorReport = {
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

describe("native browser error reporting", () => {
  it("stores bounded request/lifecycle context and distinguishes operations in deduplication", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-errors-fetch-"));
    const file = path.join(dir, "browser-errors.json");
    const app = fastify();
    const record = createBrowserErrorReporter(app, file);
    const send = (operation: string) =>
      record({
        ...report,
        stage: "fetch",
        operation: operation as import("@/shared/browser-errors").BrowserErrorReport["operation"],
        startedVisibility: "visible",
        visibility: "visible",
        suspended: true,
        lifecycle: "reconnect",
      });
    try {
      await expect(send("/api/main?token=secret")).rejects.toMatchObject({ statusCode: 400 });
      await send("main");
      await send("main");
      await send("history");
      const stored = JSON.parse(await fs.readFile(file, "utf8"));
      expect(stored).toHaveLength(2);
      expect(stored[0]).toMatchObject({
        operation: "main",
        suspended: true,
        lifecycle: "reconnect",
        visibility: "visible",
        startedVisibility: "visible",
      });
      expect(stored[1].operation).toBe("history");
      expect(JSON.stringify(stored)).not.toContain("secret");
    } finally {
      await app.close();
    }
  });
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
    const record = createBrowserErrorReporter(app, file);
    try {
      await record(report);
      const stored = JSON.parse(await fs.readFile(file, "utf8"));
      expect(stored).toHaveLength(200);
      expect(stored.every((r: any) => Date.parse(r.receivedAt) > Date.now() - 86400000)).toBe(true);
      expect(stored.at(-1).correlationId).toBe("test-id");
      if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await app.close();
    }
  });
  it("bounds, sanitizes and deduplicates stored reports", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-errors-"));
    const app = fastify();
    const file = path.join(dir, "browser-errors.json");
    const send = createBrowserErrorReporter(app, file);
    try {
      await expect(send({ ...report, stack: "x".repeat(9000) })).rejects.toMatchObject({
        statusCode: 400,
      });
      await send(report);
      await send(report);
      const stored = JSON.parse(await fs.readFile(file, "utf8"));
      expect(stored).toHaveLength(1);
      expect(stored[0].message).toBe("Error details redacted");
      expect(stored[0].stack).toBe("/assets/main.js:10:20");
      expect(JSON.stringify(stored)).not.toContain("secret");
      expect(stored[0].status).toBe(413);
      for (let n = 0; n < 19; n++) await send({ ...report, status: 500 + n });
      await expect(send({ ...report, status: 599 })).rejects.toMatchObject({ statusCode: 429 });
    } finally {
      await app.close();
    }
  });
});
