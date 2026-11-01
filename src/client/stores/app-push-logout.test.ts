import { createPinia, setActivePinia } from "pinia";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { logout } from "@/client/lib/api";
import { unregisterPushSubscription } from "@/client/lib/push-notifications";
import { useAppStore } from "./app";
vi.mock("@/client/lib/main-cache", () => ({
  CACHE_DAY_MS: 86_400_000,
  CACHE_EPOCH_KEY: "batty:main-cache-epoch",
  REVOKED_CACHE_SCOPE_KEY: "batty:revoked-cache-scope",
  registerMainCacheBootstrap: vi.fn(),
  authorizePreviewCache: vi.fn(),
  readMainCache: vi.fn(),
  readMainCachePage: vi.fn(),
  saveMainCache: vi.fn(),
  clearMainCache: vi.fn(),
}));

vi.mock("@/client/lib/api", () => ({ logout: vi.fn() }));
vi.mock("@/client/lib/push-notifications", () => ({
  unregisterPushSubscription: vi.fn(),
  syncPushSubscription: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  setActivePinia(createPinia());
});

test("logout waits for device push removal before clearing authentication", async () => {
  let complete!: () => void;
  vi.mocked(unregisterPushSubscription).mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const store = useAppStore();
  store.authenticated = true;
  const pending = store.logout();
  expect(logout).not.toHaveBeenCalled();
  expect(store.authenticated).toBe(true);
  complete();
  await pending;
  expect(logout).toHaveBeenCalledOnce();
  expect(store.authenticated).toBe(false);
});

test("failed device push removal leaves authentication available for retry", async () => {
  vi.mocked(unregisterPushSubscription).mockRejectedValue(new Error("push removal failed"));
  const store = useAppStore();
  store.authenticated = true;
  await expect(store.logout()).rejects.toThrow("push removal failed");
  expect(logout).not.toHaveBeenCalled();
  expect(store.authenticated).toBe(true);
});
