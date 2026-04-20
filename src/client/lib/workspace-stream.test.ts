import { afterEach, describe, expect, it } from "vite-plus/test";
import { workspaceEventsPath } from "@/client/lib/workspace-stream";

afterEach(() => {
  delete window.__BATTY_BASE_URL__;
});

describe("workspace-stream", () => {
  it("builds workspace event routes with encoded ids", () => {
    expect(workspaceEventsPath("batty/workspace")).toBe("/api/workspaces/batty%2Fworkspace/events");
  });

  it("prefixes workspace event routes with the configured base url", () => {
    window.__BATTY_BASE_URL__ = "/batty";

    expect(workspaceEventsPath("batty/workspace")).toBe(
      "/batty/api/workspaces/batty%2Fworkspace/events",
    );
  });
});
