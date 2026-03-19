import { describe, expect, it } from "vite-plus/test";
import { sessionRoutePath, workspaceRoutePath } from "@/client/lib/routes";

describe("routes", () => {
  it("builds workspace routes", () => {
    expect(workspaceRoutePath("batty")).toBe("/workspaces/batty");
  });

  it("builds session routes with encoded ids", () => {
    expect(sessionRoutePath("batty", "session/123")).toBe(
      "/workspaces/batty/sessions/session%2F123",
    );
  });
});
