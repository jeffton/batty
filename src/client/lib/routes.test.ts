import { describe, expect, it } from "vite-plus/test";
import { sessionRoutePath, workspaceRoutePath } from "@/client/lib/routes";

describe("routes", () => {
  it("builds workspace routes", () => {
    expect(workspaceRoutePath("pi-face")).toBe("/workspaces/pi-face");
  });

  it("builds session routes with encoded ids", () => {
    expect(sessionRoutePath("pi-face", "session/123")).toBe(
      "/workspaces/pi-face/sessions/session%2F123",
    );
  });
});
