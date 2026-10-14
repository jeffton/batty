import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  authorizeErrorReporting,
  reportBrowserError,
  recordErrorLifecycle,
} from "./browser-errors";
import { getMain, getMainMessages } from "./api";
import { checkAppUpdate, initializeBuild } from "./app-updates";

afterEach(() => {
  authorizeErrorReporting(false);
  vi.restoreAllMocks();
});
describe("browser error reporting isolation", () => {
  it("attributes a caught request abort across suspension/reconnect without changing the rejection", async () => {
    authorizeErrorReporting(true);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let reject!: (error: Error) => void;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(new Response());
    const request = getMain("private-history-cursor");
    visibility.mockReturnValue("hidden");
    recordErrorLifecycle("hidden");
    visibility.mockReturnValue("visible");
    recordErrorLifecycle("visible");
    recordErrorLifecycle("reconnect");
    const error = new Error("Fetch is aborted");
    error.name = "AbortError";
    reject(error);
    await expect(request).rejects.toBe(error);
    const report = JSON.parse(fetch.mock.calls[1]![1]!.body as string);
    expect(report).toMatchObject({
      stage: "fetch",
      operation: "main",
      errorName: "AbortError",
      message: "Fetch is aborted",
      startedVisibility: "visible",
      visibility: "visible",
      suspended: true,
      lifecycle: "reconnect",
    });
    expect(JSON.stringify(report)).not.toContain("private-history-cursor");
    // A different operation with the same failure must not be deduplicated away.
    fetch.mockRejectedValueOnce(error);
    await expect(getMainMessages({ before: "another-private-cursor" })).rejects.toBe(error);
    const history = JSON.parse(fetch.mock.calls[3]![1]!.body as string);
    expect(history).toMatchObject({ operation: "history", suspended: false });
    expect(JSON.stringify(history)).not.toContain("another-private-cursor");
  });
  it("reports version and shell body aborts and releases the update check for recovery", async () => {
    authorizeErrorReporting(true);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    initializeBuild("old");
    const error = new Error("Fetch is aborted");
    error.name = "AbortError";
    const version = new Response();
    vi.spyOn(version, "json").mockRejectedValue(error);
    const shell = new Response();
    vi.spyOn(shell, "text").mockRejectedValue(error);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(version)
      .mockResolvedValueOnce(new Response());
    await expect(checkAppUpdate()).rejects.toBe(error);
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toMatchObject({
      operation: "version",
    });
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ buildId: "new" }) } as Response)
      .mockResolvedValueOnce(shell)
      .mockResolvedValueOnce(new Response());
    await expect(checkAppUpdate()).rejects.toBe(error);
    expect(JSON.parse(fetch.mock.calls[4]![1]!.body as string)).toMatchObject({
      operation: "app-shell",
    });
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ buildId: "old" }) } as Response);
    await expect(checkAppUpdate()).resolves.toBeUndefined();
  });
  it("reports native cache diagnostics and asset stack without arbitrary error text", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    authorizeErrorReporting(true);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const error = new Error(
      "Attempt to get a record from database without an in-progress transaction",
    );
    error.name = "UnknownError";
    error.stack =
      "UnknownError: private text\nrequest@https://example.test/assets/index-test.js:20:30";
    reportBrowserError(error, "cache-write");
    const report = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(report).toMatchObject({
      stage: "cache-write",
      errorName: "UnknownError",
      message: error.message,
      stack: "/assets/index-test.js:20:30",
    });
    expect(JSON.stringify(report)).not.toContain("private text");
  });
  it("drops offline/unauthenticated reports, deduplicates, and contains transport errors", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Telemetry unavailable");
    });
    reportBrowserError(new Error("Load failed"), "window");
    expect(fetch).not.toHaveBeenCalled();
    authorizeErrorReporting(true);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    reportBrowserError(new Error("Load failed"), "window");
    expect(fetch).not.toHaveBeenCalled();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    expect(() => reportBrowserError(new Error("Load failed"), "window")).not.toThrow();
    reportBrowserError(new Error("Load failed"), "window");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
