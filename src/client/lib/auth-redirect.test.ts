import { beforeEach, describe, expect, it } from "vite-plus/test";
import { resolveAuthReturnTo } from "./auth-redirect";

describe("resolveAuthReturnTo", () => {
  beforeEach(() => {
    window.__BATTY_BASE_URL__ = "/batty";
  });

  it("accepts site URLs under the Batty base path", () => {
    expect(resolveAuthReturnTo("/batty/sites/site-1/?preview=2#section")).toBe(
      "/batty/sites/site-1/?preview=2#section",
    );
  });

  it("rejects external and unrelated URLs", () => {
    expect(resolveAuthReturnTo("https://example.com/")).toBeUndefined();
    expect(resolveAuthReturnTo("//example.com/")).toBeUndefined();
    expect(resolveAuthReturnTo("/batty/workspaces/demo")).toBeUndefined();
  });
});
