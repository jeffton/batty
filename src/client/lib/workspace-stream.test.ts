import { afterEach, describe, expect, it } from "vite-plus/test";
import { workspaceEventsPath } from "@/client/lib/workspace-stream";

afterEach(() => {
  delete window.__BATTY_BASE_URL__;
});

describe("workspace-stream", () => {
  it("builds the multiplexed workspace event route", () => {
    expect(workspaceEventsPath()).toBe("/api/workspaces/events");
  });

  it("prefixes workspace event routes with the configured base url", () => {
    window.__BATTY_BASE_URL__ = "/batty";

    expect(workspaceEventsPath()).toBe("/batty/api/workspaces/events");
  });
});
