import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { rpcCall } from "./rpc";
vi.mock("./rpc", () => ({ rpcCall: vi.fn(), closeRpcTransport: vi.fn() }));
import {
  authorizeErrorReporting,
  reportBrowserError,
  recordErrorLifecycle,
} from "./browser-errors";
import { getMain, getMainMessages } from "./api";
import { checkAppUpdate, initializeBuild } from "./app-updates";
const reportAt = (index: number) =>
  (vi.mocked(rpcCall).mock.calls[index]![1] as { report: object }).report;
afterEach(() => {
  authorizeErrorReporting(false);
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
describe("browser error reporting isolation", () => {
  it("attributes interrupted domain calls across suspension without changing the rejection", async () => {
    authorizeErrorReporting(true);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let reject!: (error: Error) => void;
    vi.mocked(rpcCall)
      .mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue({ value: {} });
    const pending = getMain("private-history-cursor");
    visibility.mockReturnValue("hidden");
    recordErrorLifecycle("hidden");
    visibility.mockReturnValue("visible");
    recordErrorLifecycle("visible");
    recordErrorLifecycle("reconnect");
    const error = new DOMException("Fetch is aborted", "AbortError");
    reject(error);
    await expect(pending).rejects.toBe(error);
    expect(reportAt(1)).toMatchObject({
      stage: "fetch",
      operation: "main",
      errorName: "AbortError",
      startedVisibility: "visible",
      visibility: "visible",
      suspended: true,
      lifecycle: "reconnect",
    });
    expect(JSON.stringify(reportAt(1))).not.toContain("private-history-cursor");
    vi.mocked(rpcCall).mockRejectedValueOnce(error);
    await expect(getMainMessages({ before: "another-private-cursor" })).rejects.toBe(error);
    expect(reportAt(3)).toMatchObject({ operation: "history", suspended: false });
    expect(JSON.stringify(reportAt(3))).not.toContain("another-private-cursor");
  });
  it("reports public version/shell failures through native diagnostics and permits HTTP recovery", async () => {
    authorizeErrorReporting(true);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.mocked(rpcCall).mockResolvedValue({ value: {} });
    initializeBuild("old");
    const error = new DOMException("Fetch is aborted", "AbortError");
    const version = new Response();
    vi.spyOn(version, "json").mockRejectedValue(error);
    const shell = new Response();
    vi.spyOn(shell, "text").mockRejectedValue(error);
    const http = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(version);
    await expect(checkAppUpdate()).rejects.toBe(error);
    expect(reportAt(0)).toMatchObject({ operation: "version" });
    http
      .mockResolvedValueOnce({ ok: true, json: async () => ({ buildId: "new" }) } as Response)
      .mockResolvedValueOnce(shell);
    await expect(checkAppUpdate()).rejects.toBe(error);
    expect(reportAt(1)).toMatchObject({ operation: "app-shell" });
    http.mockResolvedValueOnce({ ok: true, json: async () => ({ buildId: "old" }) } as Response);
    await expect(checkAppUpdate()).resolves.toBeUndefined();
  });
  it("sends sanitized diagnostic objects without arbitrary error text", () => {
    vi.mocked(rpcCall).mockResolvedValue({ value: {} });
    authorizeErrorReporting(true);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const error = new Error(
      "Attempt to get a record from database without an in-progress transaction",
    );
    error.name = "UnknownError";
    error.stack =
      "UnknownError: private text\nrequest@https://example.test/assets/index-test.js:20:30";
    reportBrowserError(error, "cache-write");
    expect(vi.mocked(rpcCall).mock.calls[0]![0]).toBe("diagnostics.report");
    expect(reportAt(0)).toMatchObject({
      stage: "cache-write",
      errorName: "UnknownError",
      message: error.message,
      stack: "/assets/index-test.js:20:30",
    });
    expect(JSON.stringify(reportAt(0))).not.toContain("private text");
  });
  it("drops offline/unauthenticated reports, deduplicates, and contains diagnostics failures", () => {
    vi.mocked(rpcCall).mockImplementation(() => {
      throw new Error("Telemetry unavailable");
    });
    reportBrowserError(new Error("Load failed"), "window");
    expect(rpcCall).not.toHaveBeenCalled();
    authorizeErrorReporting(true);
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    reportBrowserError(new Error("Load failed"), "window");
    expect(rpcCall).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    expect(() => reportBrowserError(new Error("Load failed"), "window")).not.toThrow();
    reportBrowserError(new Error("Load failed"), "window");
    expect(rpcCall).toHaveBeenCalledOnce();
  });
});
