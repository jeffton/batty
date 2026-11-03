import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { deletePushSubscription, getPushPublicKey, savePushSubscription } from "@/client/lib/api";
import { syncPushSubscription, unregisterPushSubscription } from "@/client/lib/push-notifications";

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

function installPushCapableBrowser(permission: NotificationPermission = "default"): {
  subscribe: ReturnType<typeof vi.fn>;
  getSubscription: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
  getRegistration: ReturnType<typeof vi.fn>;
  registration: {
    scope: string;
    active: { state: string };
    pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
  };
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
    static permission: NotificationPermission = permission;
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
  const base = window.__BATTY_BASE_URL__ ?? "/";
  const registration = {
    scope: new URL(base === "/" ? "/" : `${base}/`, window.location.origin).href,
    active: { state: "activated" },
    pushManager: { getSubscription, subscribe },
  };
  const getRegistration = vi.fn().mockResolvedValue(registration);
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration },
  });

  return {
    subscribe,
    getSubscription,
    requestPermission,
    getRegistration,
    registration,
  };
}

beforeEach(() => {
  delete window.__BATTY_BASE_URL__;
  vi.clearAllMocks();
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
  delete window.__BATTY_BASE_URL__;
  vi.restoreAllMocks();
});

describe("unregisterPushSubscription", () => {
  it("removes the device from the server before unsubscribing locally", async () => {
    const browser = installPushCapableBrowser("granted");
    const unsubscribe = vi.fn(async () => {
      expect(mockedDeletePushSubscription).toHaveBeenCalledWith("https://push.example/device");
      return true;
    });
    browser.getSubscription.mockResolvedValue({
      endpoint: "https://push.example/device",
      unsubscribe,
    });
    await unregisterPushSubscription();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight registration before removing the device", async () => {
    const browser = installPushCapableBrowser("granted");
    const unsubscribe = vi.fn().mockResolvedValue(true);
    browser.getSubscription.mockResolvedValue({
      endpoint: "https://push.example/device",
      toJSON: () => ({ endpoint: "https://push.example/device" }),
      unsubscribe,
    });
    let complete!: (value: { ok: true }) => void;
    mockedSavePushSubscription.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const sync = syncPushSubscription(false);
    await vi.waitFor(() => expect(mockedSavePushSubscription).toHaveBeenCalled());
    const removal = unregisterPushSubscription();
    expect(unsubscribe).not.toHaveBeenCalled();
    complete({ ok: true });
    await Promise.all([sync, removal]);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("syncPushSubscription", () => {
  it("uses this installation's registration rather than an ancestor's ready worker", async () => {
    window.__BATTY_BASE_URL__ = "/nested/app";
    const browser = installPushCapableBrowser("granted");
    await expect(syncPushSubscription(false)).resolves.toBe(true);
    expect(browser.getRegistration).toHaveBeenCalledWith(
      new URL("/nested/app/", window.location.origin).href,
    );
  });

  it("never subscribes or unsubscribes the root registration for a nested installation", async () => {
    window.__BATTY_BASE_URL__ = "/batty";
    const browser = installPushCapableBrowser("granted");
    browser.registration.scope = new URL("/", window.location.origin).href;
    await expect(syncPushSubscription(false)).resolves.toBe(false);
    await unregisterPushSubscription();
    expect(browser.getSubscription).not.toHaveBeenCalled();
    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(mockedDeletePushSubscription).not.toHaveBeenCalled();
  });

  it("waits for its own worker to activate rather than using a different ready registration", async () => {
    window.__BATTY_BASE_URL__ = "/batty-safe";
    const browser = installPushCapableBrowser("granted");
    const worker = new EventTarget() as EventTarget & { state: string };
    worker.state = "installing";
    browser.getRegistration.mockResolvedValue({
      ...browser.registration,
      active: null,
      installing: worker,
    });
    const sync = syncPushSubscription(false);
    await vi.waitFor(() => expect(browser.getRegistration).toHaveBeenCalled());
    expect(browser.subscribe).not.toHaveBeenCalled();
    worker.state = "activated";
    worker.dispatchEvent(new Event("statechange"));
    await expect(sync).resolves.toBe(true);
  });

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
    const browser = installPushCapableBrowser("denied");
    browser.getSubscription.mockResolvedValue({ endpoint: "https://push.example/subscription" });

    await expect(syncPushSubscription(false)).resolves.toBe(false);
    expect(mockedDeletePushSubscription).toHaveBeenCalledWith("https://push.example/subscription");
  });
});
