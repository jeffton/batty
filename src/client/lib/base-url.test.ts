import { afterEach, describe, expect, it } from "vite-plus/test";
import { appBaseUrl, stripBaseUrl, withBaseUrl } from "@/client/lib/base-url";

afterEach(() => {
  delete window.__BATTY_BASE_URL__;
});

describe("base-url", () => {
  it("defaults to the root base url", () => {
    expect(appBaseUrl()).toBe("/");
    expect(withBaseUrl("/api/bootstrap")).toBe("/api/bootstrap");
    expect(stripBaseUrl("/workspaces/batty")).toBe("/workspaces/batty");
  });

  it("prefixes and strips a configured non-root base url", () => {
    window.__BATTY_BASE_URL__ = "/batty/";

    expect(appBaseUrl()).toBe("/batty");
    expect(withBaseUrl("/api/bootstrap")).toBe("/batty/api/bootstrap");
    expect(withBaseUrl("/")).toBe("/batty");
    expect(stripBaseUrl("/batty/workspaces/batty")).toBe("/workspaces/batty");
    expect(stripBaseUrl("/other/workspaces/batty")).toBeUndefined();
  });
});
