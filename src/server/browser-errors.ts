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
export function createBrowserErrorReporter(
  app: FastifyInstance,
  file: string,
): (input: BrowserErrorReport) => Promise<void> {
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
  const reportBrowserError = async (input: BrowserErrorReport) => {
    const required = [
      "timestamp",
      "correlationId",
      "buildId",
      "stage",
      "browser",
      "platform",
      "errorName",
      "message",
      "stack",
    ] as const;
    const invalid = () => {
      throw Object.assign(new Error("Invalid browser error report"), { statusCode: 400 });
    };
    if (
      !input ||
      typeof input !== "object" ||
      required.some((name) => typeof input[name] !== "string")
    )
      invalid();
    if (
      !Number.isFinite(Date.parse(input.timestamp)) ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(input.correlationId) ||
      !/^[a-zA-Z0-9.-]{1,64}$/.test(input.buildId) ||
      !errorStages.includes(input.stage) ||
      !errorNames.includes(input.errorName) ||
      !["Edge", "Firefox", "Chrome", "WebKit", "Other"].includes(input.browser) ||
      !["iOS", "Android", "macOS", "Windows", "Linux", "Other"].includes(input.platform) ||
      input.message.length > 256 ||
      input.stack.length > 2048
    )
      invalid();
    if (
      (input.status !== undefined &&
        (!Number.isInteger(input.status) || input.status < 100 || input.status > 599)) ||
      (input.operation !== undefined && !fetchOperations.includes(input.operation)) ||
      (input.lifecycle !== undefined && !lifecycleEvents.includes(input.lifecycle)) ||
      (input.visibility !== undefined && !["hidden", "visible"].includes(input.visibility)) ||
      (input.startedVisibility !== undefined &&
        !["hidden", "visible"].includes(input.startedVisibility)) ||
      (input.suspended !== undefined && typeof input.suspended !== "boolean") ||
      (input.hasFiles !== undefined && typeof input.hasFiles !== "boolean") ||
      Object.keys(input).some(
        (key) =>
          ![
            ...required,
            "status",
            "hasFiles",
            "operation",
            "visibility",
            "startedVisibility",
            "suspended",
            "lifecycle",
          ].includes(key),
      )
    )
      invalid();
    const report = {
      ...input,
      message: safeErrorMessage(input.message),
      stack: safeErrorStack(input.stack),
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
    if (recent.length >= 20)
      throw Object.assign(new Error("Report limit reached"), { statusCode: 429 });
    if (recent.some((entry) => entry.key === key)) return;
    recent.push({ key, time: now });
    const write = writes.then(() => persist(report));
    writes = write.catch((error) => app.log.error(error, "Browser error persistence"));
    await write;
    return;
  };
  return reportBrowserError;
}
