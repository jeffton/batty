import fs from "node:fs";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  browserExecutablePath,
  chromeCandidates,
  isolatedBrowserExecutablePath,
} from "./browser-executable";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test("discovery covers system and per-user Chrome installations without test bundles", () => {
  expect(chromeCandidates("linux")).toEqual(["/opt/google/chrome/chrome"]);
  expect(chromeCandidates("darwin", {}, "/Users/test")).toEqual([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Users/test/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]);
  expect(
    chromeCandidates("win32", {
      PROGRAMFILES: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
    }),
  ).toEqual([
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
  ]);
});

test("missing Chrome fails explicitly instead of selecting bundled Chromium", () => {
  vi.stubEnv("BATTY_BROWSER_EXECUTABLE_PATH", undefined);
  vi.spyOn(fs, "existsSync").mockReturnValue(false);
  expect(() => browserExecutablePath()).toThrow("Google Chrome Stable is not installed");
});

test("explicit selection must exist and never triggers discovery", () => {
  vi.stubEnv("BATTY_BROWSER_EXECUTABLE_PATH", "/selected/chrome");
  const access = vi.spyOn(fs, "accessSync").mockImplementation(() => {});
  const exists = vi.spyOn(fs, "existsSync");
  expect(browserExecutablePath()).toBe("/selected/chrome");
  expect(exists).not.toHaveBeenCalled();
  access.mockImplementation(() => {
    throw new Error("ENOENT");
  });
  expect(() => browserExecutablePath()).toThrow("ENOENT");
});

test.each(["", "relative/chrome"])("invalid override %j fails", (selected) => {
  vi.stubEnv("BATTY_BROWSER_EXECUTABLE_PATH", selected);
  expect(() => browserExecutablePath()).toThrow("absolute executable path");
});

test("root isolation uses system Chrome directly and maps only test bundles", () => {
  vi.stubEnv("BATTY_BROWSER_EXECUTABLE_PATH", undefined);
  expect(isolatedBrowserExecutablePath("/opt/google/chrome/chrome")).toBe(
    "/opt/google/chrome/chrome",
  );
  expect(isolatedBrowserExecutablePath("/cache/chromium-1248/chrome-linux64/chrome")).toBe(
    "/opt/batty-browser/chromium-1248/chrome-linux64/chrome",
  );
  vi.stubEnv("BATTY_BROWSER_EXECUTABLE_PATH", "/tmp/chrome");
  expect(() => isolatedBrowserExecutablePath("/tmp/chrome")).toThrow("/opt/google/chrome/chrome");
});
