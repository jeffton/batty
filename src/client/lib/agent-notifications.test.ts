import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { primeAgentNotifications } from "@/client/lib/agent-notifications";

const originalNotification = globalThis.Notification;

afterEach(() => {
  if (originalNotification) {
    globalThis.Notification = originalNotification;
  } else {
    Reflect.deleteProperty(globalThis, "Notification");
  }

  vi.restoreAllMocks();
});

describe("primeAgentNotifications", () => {
  it("requests notification permission when still undecided", async () => {
    class MockNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = vi.fn().mockImplementation(async () => {
        MockNotification.permission = "granted";
        return "granted";
      });
    }

    const requestPermission = MockNotification.requestPermission;

    globalThis.Notification = MockNotification as unknown as typeof Notification;

    await expect(primeAgentNotifications()).resolves.toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("does not request permission after a denial", async () => {
    const requestPermission = vi.fn();

    class MockNotification {
      static permission: NotificationPermission = "denied";
      static requestPermission = requestPermission;
    }

    globalThis.Notification = MockNotification as unknown as typeof Notification;

    await expect(primeAgentNotifications()).resolves.toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
