import { describe, expect, it } from "vite-plus/test";
import {
  NOTIFICATION_NAVIGATION_MESSAGE_TYPE,
  notificationPathFromUrl,
} from "@/client/lib/notification-navigation";

describe("notificationPathFromUrl", () => {
  it("keeps same-origin session paths", () => {
    expect(
      notificationPathFromUrl(
        "/workspaces/batty/sessions/session-123?source=push#latest",
        "https://batty.test",
      ),
    ).toBe("/workspaces/batty/sessions/session-123?source=push#latest");
  });

  it("rejects cross-origin targets", () => {
    expect(notificationPathFromUrl("https://example.com/nope", "https://batty.test")).toBe(
      undefined,
    );
  });

  it("exports a stable message type", () => {
    expect(NOTIFICATION_NAVIGATION_MESSAGE_TYPE).toBe("notification-navigate");
  });
});
