import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { deletePushSubscription, getPushPublicKey, savePushSubscription } from "@/client/lib/api";
import { supportsWebPush, syncPushSubscription } from "@/client/lib/push-notifications";

vi.mock("@/client/lib/api", () => ({
  getPushPublicKey: vi.fn(),
  savePushSubscription: vi.fn(),
  deletePushSubscription: vi.fn(),
}));

const mockedGetPushPublicKey = vi.mocked(getPushPublicKey);
const mockedSavePushSubscription = vi.mocked(savePushSubscription);
const mockedDeletePushSubscription = vi.mocked(deletePushSubscription);
const originalNotification = globalThis.Notification;
const originalServiceWorker = navigator.serviceWorker;
const originalPushManager = globalThis.PushManager;
const originalServiceWorkerRegistration = globalThis.ServiceWorkerRegistration;

function installPushCapableBrowser(): {
  subscribe: ReturnType<typeof vi.fn>;
  getSubscription: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
} {
  const subscribe = vi.fn().mockResolvedValue({
    endpoint: "https://push.example/subscription",
    toJSON: () => ({
      endpoint: "https://push.example/subscription",
      expirationTime: null,
      keys: {
        p256dh: "p256dh-key",
        auth: "auth-key",
      },
    }),
  });
  const getSubscription = vi.fn().mockResolvedValue(null);
  class MockNotification {
    static permission: NotificationPermission = "default";
    static requestPermission = vi.fn().mockImplementation(async () => {
      MockNotification.permission = "granted";
      return "granted";
    });
  }

  const requestPermission = MockNotification.requestPermission;

  class MockPushManager {}
  class MockServiceWorkerRegistration {}
  Object.defineProperty(MockServiceWorkerRegistration.prototype, "showNotification", {
    configurable: true,
    value: vi.fn(),
  });

  globalThis.Notification = MockNotification as unknown as typeof Notification;
  globalThis.PushManager = MockPushManager as unknown as typeof PushManager;
  globalThis.ServiceWorkerRegistration =
    MockServiceWorkerRegistration as unknown as typeof ServiceWorkerRegistration;
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: {
          getSubscription,
          subscribe,
        },
      }),
    },
  });

  return {
    subscribe,
    getSubscription,
    requestPermission,
  };
}

beforeEach(() => {
  mockedGetPushPublicKey.mockResolvedValue({
    publicKey:
      "BKagOnB4dK8vT0xW4xF6vWZL2j9x0x6g6VGQAcY1O5uN0A2qP8mRjvT1P4h4m0sFfrY6pR5dYl1xJY7f1P9b7Rk",
  });
  mockedSavePushSubscription.mockResolvedValue({ ok: true });
  mockedDeletePushSubscription.mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (originalNotification) {
    globalThis.Notification = originalNotification;
  } else {
    Reflect.deleteProperty(globalThis, "Notification");
  }
  if (originalPushManager) {
    globalThis.PushManager = originalPushManager;
  } else {
    Reflect.deleteProperty(globalThis, "PushManager");
  }
  if (originalServiceWorkerRegistration) {
    globalThis.ServiceWorkerRegistration = originalServiceWorkerRegistration;
  } else {
    Reflect.deleteProperty(globalThis, "ServiceWorkerRegistration");
  }
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: originalServiceWorker,
  });
  vi.restoreAllMocks();
});

describe("supportsWebPush", () => {
  it("detects a push-capable browser environment", () => {
    installPushCapableBrowser();
    expect(supportsWebPush()).toBe(true);
  });
});

describe("syncPushSubscription", () => {
  it("requests permission and saves a new subscription", async () => {
    const browser = installPushCapableBrowser();

    await expect(syncPushSubscription(true)).resolves.toBe(true);
    expect(browser.requestPermission).toHaveBeenCalledTimes(1);
    expect(browser.subscribe).toHaveBeenCalledTimes(1);
    expect(mockedSavePushSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://push.example/subscription" }),
    );
  });

  it("removes the server subscription when permission is not granted", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const getSubscription = vi.fn().mockResolvedValue({
      endpoint: "https://push.example/subscription",
      unsubscribe,
    });

    class MockNotification {
      static permission: NotificationPermission = "denied";
      static requestPermission = vi.fn();
    }

    class MockPushManager {}
    class MockServiceWorkerRegistration {}
    Object.defineProperty(MockServiceWorkerRegistration.prototype, "showNotification", {
      configurable: true,
      value: vi.fn(),
    });

    globalThis.Notification = MockNotification as unknown as typeof Notification;
    globalThis.PushManager = MockPushManager as unknown as typeof PushManager;
    globalThis.ServiceWorkerRegistration =
      MockServiceWorkerRegistration as unknown as typeof ServiceWorkerRegistration;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription,
            subscribe: vi.fn(),
          },
        }),
      },
    });

    await expect(syncPushSubscription(false)).resolves.toBe(false);
    expect(mockedDeletePushSubscription).toHaveBeenCalledWith("https://push.example/subscription");
  });
});
