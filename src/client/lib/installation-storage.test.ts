import { afterEach, expect, it } from "vite-plus/test";
import { installationStorageKey } from "./installation-storage";

afterEach(() => {
  delete window.__BATTY_BASE_URL__;
});

it("canonicalizes installation paths without confusing siblings, nesting or root", () => {
  for (const [base, expected] of [
    [undefined, "batty:%2F:epoch"],
    ["/", "batty:%2F:epoch"],
    ["batty", "batty:%2Fbatty:epoch"],
    [" /batty/ ", "batty:%2Fbatty:epoch"],
    ["/batty-safe", "batty:%2Fbatty-safe:epoch"],
    ["/batty/safe", "batty:%2Fbatty%2Fsafe:epoch"],
  ] as const) {
    window.__BATTY_BASE_URL__ = base;
    expect(installationStorageKey("epoch")).toBe(expected);
  }
});
