import { afterEach, describe, expect, it } from "vite-plus/test";
import { notificationPathFromUrl } from "@/client/lib/notification-navigation";

afterEach(() => {
  delete window.__BATTY_BASE_URL__;
});

describe("notificationPathFromUrl", () => {
  it("keeps same-origin session paths", () => {
    expect(
      notificationPathFromUrl(
        "/workspaces/batty/sessions/session-123?source=push#latest",
        "https://batty.test",
      ),
    ).toBe("/workspaces/batty/sessions/session-123?source=push#latest");
  });

  it("strips the configured base url from same-origin session paths", () => {
    window.__BATTY_BASE_URL__ = "/batty";

    expect(
      notificationPathFromUrl(
        "/batty/workspaces/batty/sessions/session-123?source=push#latest",
        "https://batty.test",
      ),
    ).toBe("/workspaces/batty/sessions/session-123?source=push#latest");
  });

  it("rejects cross-origin targets", () => {
    expect(notificationPathFromUrl("https://example.com/nope", "https://batty.test")).toBe(
      undefined,
    );
  });
});
