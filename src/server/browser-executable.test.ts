import { afterEach, expect, test, vi } from "vite-plus/test";
import { browserExecutablePath, isolatedBrowserExecutablePath } from "./browser-executable";

afterEach(() => vi.unstubAllEnvs());

test("default browser retains the pinned bundle and isolation mapping", () => {
  vi.stubEnv("BATTY_BROWSER_EXECUTABLE_PATH", undefined);
  const bundled = "/cache/chromium-1248/chrome-linux64/chrome";
  expect(browserExecutablePath(() => bundled)).toBe(bundled);
  expect(isolatedBrowserExecutablePath(bundled)).toBe(
    "/opt/batty-browser/chromium-1248/chrome-linux64/chrome",
  );
});

test("explicit security browser is never mapped to a bundled revision", () => {
  const selected = "/opt/batty-browser/chromium-security-156.0.8078.73/chrome-linux64/chrome";
  vi.stubEnv("BATTY_BROWSER_EXECUTABLE_PATH", selected);
  const bundled = vi.fn(() => {
    throw new Error("bundle unavailable");
  });
  expect(browserExecutablePath(bundled)).toBe(selected);
  expect(isolatedBrowserExecutablePath(selected)).toBe(selected);
  expect(bundled).not.toHaveBeenCalled();
});

test.each(["", "relative/chrome"])(
  "invalid explicit path %j fails instead of selecting bundle",
  (selected) => {
    vi.stubEnv("BATTY_BROWSER_EXECUTABLE_PATH", selected);
    expect(() => browserExecutablePath(() => "/bundle/chrome")).toThrow("absolute executable path");
  },
);

test("root isolation rejects explicit binaries outside its installation tree", () => {
  vi.stubEnv("BATTY_BROWSER_EXECUTABLE_PATH", "/tmp/chrome");
  expect(() => isolatedBrowserExecutablePath("/tmp/chrome")).toThrow("/opt/batty-browser");
});
