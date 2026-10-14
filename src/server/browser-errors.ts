import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  errorStages,
  errorNames,
  fetchOperations,
  lifecycleEvents,
  safeErrorMessage,
  safeErrorStack,
  type BrowserErrorReport,
} from "@/shared/browser-errors";

const MAX_REPORTS = 200;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export function registerBrowserErrorRoutes(app: FastifyInstance, file: string): void {
  let writes = Promise.resolve();
  let recent: { key: string; time: number }[] = [];
  const prune = async () => {
    let reports: (BrowserErrorReport & { receivedAt: string })[];
    try {
      reports = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      reports = [];
    }
    return reports
      .filter((report) => Date.now() - Date.parse(report.receivedAt) < RETENTION_MS)
      .slice(-MAX_REPORTS);
  };
  const persist = async (report?: BrowserErrorReport) => {
    const reports = await prune();
    if (report) reports.push({ ...report, receivedAt: new Date().toISOString() });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(reports.slice(-MAX_REPORTS), null, 2) + "\n", {
      mode: 0o600,
    });
    await fs.rename(`${file}.tmp`, file);
  };
  const cleanup = setInterval(
    () => {
      writes = writes
        .then(() => persist())
        .catch((error) => app.log.error(error, "Browser error retention"));
    },
    60 * 60 * 1000,
  );
  cleanup.unref();
  app.addHook("onClose", async () => {
    clearInterval(cleanup);
    await writes;
  });
  app.post<{ Body: BrowserErrorReport }>(
    "/api/browser-errors",
    {
      bodyLimit: 8 * 1024,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "timestamp",
            "correlationId",
            "buildId",
            "stage",
            "browser",
            "platform",
            "errorName",
            "message",
            "stack",
          ],
          properties: {
            timestamp: { type: "string", format: "date-time" },
            correlationId: { type: "string", pattern: "^[a-zA-Z0-9-]{1,64}$" },
            buildId: { type: "string", pattern: "^[a-zA-Z0-9.-]{1,64}$" },
            stage: { type: "string", enum: errorStages },
            browser: { type: "string", enum: ["Edge", "Firefox", "Chrome", "WebKit", "Other"] },
            platform: {
              type: "string",
              enum: ["iOS", "Android", "macOS", "Windows", "Linux", "Other"],
            },
            errorName: { type: "string", enum: errorNames },
            message: { type: "string", maxLength: 256 },
            stack: { type: "string", maxLength: 2048 },
            status: { type: "integer", minimum: 100, maximum: 599 },
            hasFiles: { type: "boolean" },
            operation: { type: "string", enum: fetchOperations },
            visibility: { type: "string", enum: ["hidden", "visible"] },
            startedVisibility: { type: "string", enum: ["hidden", "visible"] },
            suspended: { type: "boolean" },
            lifecycle: { type: "string", enum: lifecycleEvents },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.auth) return reply.code(401).send({ error: "Authentication required" });
      if (
        !request.headers.origin ||
        request.headers.origin !== `${request.protocol}://${request.host}`
      )
        return reply.code(403).send({ error: "Same-origin required" });
      const report = {
        ...request.body,
        message: safeErrorMessage(request.body.message),
        stack: safeErrorStack(request.body.stack),
      };
      const now = Date.now();
      recent = recent.filter((entry) => now - entry.time < 60_000);
      const key = JSON.stringify([
        report.stage,
        report.errorName,
        report.browser,
        report.platform,
        report.hasFiles,
        report.message,
        report.stack,
        report.status,
        report.buildId,
        report.operation,
        report.visibility,
        report.startedVisibility,
        report.suspended,
        report.lifecycle,
      ]);
      if (recent.length >= 20) return reply.code(429).send({ error: "Report limit reached" });
      if (recent.some((entry) => entry.key === key)) return reply.code(204).send();
      recent.push({ key, time: now });
      const write = writes.then(() => persist(report));
      writes = write.catch((error) => app.log.error(error, "Browser error persistence"));
      await write;
      return reply.code(204).send();
    },
  );
}
