import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  appServiceWorkerScope,
  getAppServiceWorkerController,
  getAppServiceWorkerRegistration,
} from "./service-worker";

const originalServiceWorker = navigator.serviceWorker;

afterEach(() => {
  delete window.__BATTY_BASE_URL__;
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: originalServiceWorker,
  });
});

it.each(["/", "/batty", "/batty-safe", "/nested/app"])(
  "targets the exact registration for %s",
  async (base) => {
    window.__BATTY_BASE_URL__ = base;
    const pathname = base === "/" ? "/" : `${base}/`;
    const registration = { scope: new URL(pathname, window.location.origin).href };
    const getRegistration = vi.fn().mockResolvedValue(registration);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration },
    });
    expect(appServiceWorkerScope()).toBe(pathname);
    await expect(getAppServiceWorkerRegistration()).resolves.toBe(registration);
    expect(getRegistration).toHaveBeenCalledWith(registration.scope);
  },
);

it.each(["/", "/batty", "/batty-safe", "/nested/app"])(
  "returns only %s's exact script controller",
  (base) => {
    window.__BATTY_BASE_URL__ = base;
    const scriptURL = new URL(`${base === "/" ? "" : base}/sw.js`, window.location.origin).href;
    const controller = { scriptURL, postMessage: vi.fn() };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { controller },
    });
    expect(getAppServiceWorkerController()).toBe(controller);
    controller.scriptURL = new URL("/other/sw.js", window.location.origin).href;
    expect(getAppServiceWorkerController()).toBeUndefined();
  },
);

it("rejects a transitional root controller on a nested first visit", () => {
  window.__BATTY_BASE_URL__ = "/batty";
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      controller: { scriptURL: new URL("/sw.js", window.location.origin).href },
    },
  });
  expect(getAppServiceWorkerController()).toBeUndefined();
});

it("rejects the ancestor registration returned before a nested worker is installed", async () => {
  window.__BATTY_BASE_URL__ = "/nested/app";
  const getRegistration = vi
    .fn()
    .mockResolvedValue({ scope: new URL("/", window.location.origin).href });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration },
  });
  await expect(getAppServiceWorkerRegistration()).resolves.toBeUndefined();
});
