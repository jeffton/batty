export const errorStages = [
  "window",
  "unhandledrejection",
  "vue",
  "file-read",
  "submit",
  "cache-read",
  "cache-write",
  "fetch",
] as const;
export type ErrorStage = (typeof errorStages)[number];

export const fetchOperations = [
  "bootstrap",
  "workspaces",
  "main",
  "history",
  "push-key",
  "push-sync",
  "push-delete",
  "logout",
  "stop",
  "queue-remove",
  "version",
  "app-shell",
] as const;
export type FetchOperation = (typeof fetchOperations)[number];
export const lifecycleEvents = [
  "startup",
  "hidden",
  "visible",
  "pagehide",
  "pageshow",
  "online",
  "offline",
  "reconnect",
] as const;
export type LifecycleEvent = (typeof lifecycleEvents)[number];

export interface BrowserErrorReport {
  timestamp: string;
  correlationId: string;
  buildId: string;
  stage: ErrorStage;
  browser: string;
  platform: string;
  errorName: string;
  message: string;
  stack: string;
  status?: number;
  hasFiles?: boolean;
  operation?: FetchOperation;
  visibility?: DocumentVisibilityState;
  startedVisibility?: DocumentVisibilityState;
  suspended?: boolean;
  lifecycle?: LifecycleEvent;
}

// Unknown error text can contain a prompt, filename, server body or credentials.
// Keep only native diagnostic phrases; stack frames retain asset locations, not text.
export const errorNames = [
  "Error",
  "TypeError",
  "ReferenceError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "NotReadableError",
  "NotFoundError",
  "SecurityError",
  "InvalidStateError",
  "QuotaExceededError",
  "UnknownError",
  "TransactionInactiveError",
  "DataCloneError",
  "Unknown",
];
export function safeErrorName(value: string): string {
  return errorNames.includes(value) ? value : "Unknown";
}
const diagnosticMessages = new Set([
  "Attempt to get a record from database without an in-progress transaction",
  "Attempt to get a record from the database without an in-progress transaction",
  "Cache operation cancelled: page suspended",
  "Cache transaction aborted",
  "Cache transaction aborted: read",
  "Cache transaction aborted: write",
  "Cache transaction aborted: clear",
  "Failed to fetch",
  "Fetch is aborted",
  "Load failed",
  "NetworkError when attempting to fetch resource.",
  "The operation was aborted.",
  "The operation timed out.",
  "Script error.",
  "ResizeObserver loop completed with undelivered notifications.",
  "Cannot read properties of undefined",
  "Cannot read properties of null",
]);
export function safeErrorMessage(value: string): string {
  if (diagnosticMessages.has(value)) return value;
  for (const prefix of ["Cannot read properties of undefined", "Cannot read properties of null"])
    if (value.startsWith(prefix)) return prefix;
  return "Error details redacted";
}
export function safeErrorStack(value: string): string {
  return value
    .split("\n")
    .slice(0, 20)
    .flatMap((line) => {
      const location = line.match(
        /(?:https?:\/\/[^\s/)]+)?(\/assets\/[\w.-]+\.js)(?:\?[^\s:)]*)?:(\d+):(\d+)/,
      );
      return location ? [`${location[1]}:${location[2]}:${location[3]}`] : [];
    })
    .slice(0, 12)
    .join("\n");
}
export function browserFamily(ua: string): string {
  if (/Edg\//.test(ua)) return "Edge";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/(Chrome|CriOS)\//.test(ua)) return "Chrome";
  if (/AppleWebKit/.test(ua)) return "WebKit";
  return "Other";
}
export function platformFamily(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "macOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "Other";
}
