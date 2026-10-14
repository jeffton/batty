import type { App } from "vue";
import { withBaseUrl } from "./base-url";
import {
  browserFamily,
  platformFamily,
  safeErrorMessage,
  safeErrorName,
  safeErrorStack,
  type ErrorStage,
  type BrowserErrorReport,
  type FetchOperation,
  type LifecycleEvent,
} from "@/shared/browser-errors";

declare const __BATTY_BUILD_ID__: string;
let authenticated = false;
let lifecycle: LifecycleEvent = "startup";
let suspensions = 0;

export function recordErrorLifecycle(event: LifecycleEvent): void {
  lifecycle = event;
  if (event === "hidden" || event === "pagehide") suspensions += 1;
}

export async function withFetchDiagnostics<T>(
  operation: FetchOperation,
  request: () => Promise<T>,
): Promise<T> {
  const startedVisibility = document.visibilityState;
  const startedSuspensions = suspensions;
  try {
    return await request();
  } catch (error) {
    reportBrowserError(error, "fetch", {
      operation,
      startedVisibility,
      suspended: suspensions !== startedSuspensions,
      status: error instanceof Error ? (error as Error & { status?: number }).status : undefined,
    });
    throw error;
  }
}
let recent: { key: string; time: number }[] = [];
export function authorizeErrorReporting(value: boolean): void {
  authenticated = value;
  if (!value) recent = [];
}

export function reportBrowserError(
  error: unknown,
  stage: ErrorStage,
  extra: Partial<
    Pick<
      BrowserErrorReport,
      "correlationId" | "status" | "hasFiles" | "operation" | "startedVisibility" | "suspended"
    >
  > = {},
): void {
  try {
    if (!authenticated || !navigator.onLine) return;
    const message = safeErrorMessage(error instanceof Error ? error.message : "");
    const stack = safeErrorStack(error instanceof Error ? (error.stack ?? "") : "");
    const now = Date.now();
    recent = recent.filter((entry) => now - entry.time < 60_000);
    const errorName = safeErrorName(
      error instanceof Error || error instanceof DOMException ? error.name : "Unknown",
    );
    const key = JSON.stringify([
      stage,
      errorName,
      message,
      stack,
      extra.status,
      extra.hasFiles,
      extra.operation,
      extra.startedVisibility,
      extra.suspended,
      document.visibilityState,
      lifecycle,
    ]);
    if (recent.length >= 10 || recent.some((entry) => entry.key === key)) return;
    recent.push({ key, time: now });
    const report: BrowserErrorReport = {
      timestamp: new Date(now).toISOString(),
      correlationId: extra.correlationId ?? crypto.randomUUID(),
      buildId: typeof __BATTY_BUILD_ID__ === "undefined" ? "dev" : __BATTY_BUILD_ID__,
      stage,
      browser: browserFamily(navigator.userAgent),
      platform: platformFamily(navigator.userAgent),
      errorName,
      message,
      stack,
      status: extra.status,
      hasFiles: extra.hasFiles,
      operation: extra.operation,
      startedVisibility: extra.startedVisibility,
      suspended: extra.suspended,
      visibility: document.visibilityState,
      lifecycle,
    };
    // Separate transport: never feed telemetry failures back into telemetry or UI.
    void fetch(withBaseUrl("/api/browser-errors"), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  } catch {
    // Reporting must never replace the original failure or recurse.
  }
}

export function installBrowserErrorReporting(app: App): void {
  document.addEventListener("visibilitychange", () =>
    recordErrorLifecycle(document.visibilityState === "hidden" ? "hidden" : "visible"),
  );
  for (const event of ["pagehide", "pageshow", "online", "offline"] as const)
    window.addEventListener(event, () => recordErrorLifecycle(event));
  window.addEventListener("error", (event) =>
    reportBrowserError(event.error ?? new Error(event.message), "window"),
  );
  window.addEventListener("unhandledrejection", (event) =>
    reportBrowserError(event.reason, "unhandledrejection"),
  );
  app.config.errorHandler = (error) => {
    reportBrowserError(error, "vue");
    console.error(error);
  };
}
