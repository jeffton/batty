import { describe, expect, it } from "vite-plus/test";
import { buildIdFromHtml } from "@/server/build-id";

describe("build-id", () => {
  it("creates a stable build id for the same html", () => {
    expect(buildIdFromHtml("<html>same</html>")).toBe(buildIdFromHtml("<html>same</html>"));
  });

  it("changes when the html changes", () => {
    expect(buildIdFromHtml("<html>old</html>")).not.toBe(buildIdFromHtml("<html>new</html>"));
  });
});
