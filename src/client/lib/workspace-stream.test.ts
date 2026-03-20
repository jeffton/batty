import { describe, expect, it } from "vite-plus/test";
import { workspaceEventsPath } from "@/client/lib/workspace-stream";

describe("workspace-stream", () => {
  it("builds workspace event routes with encoded ids", () => {
    expect(workspaceEventsPath("batty/workspace")).toBe("/api/workspaces/batty%2Fworkspace/events");
  });
});
