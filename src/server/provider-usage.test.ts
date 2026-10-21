import type { AuthResult, Credential } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { ProviderUsageUpdate } from "@/shared/types";
import { ProviderUsageService } from "./provider-usage";

const PROVIDER = "openai-codex";
const MINUTE = 60_000;
const AUTH: AuthResult = { auth: { apiKey: "access" } };

function credential(accountId = "account-a"): Credential {
  return { type: "oauth", access: "access", refresh: "refresh", expires: 9e15, accountId };
}

function response(used = 25) {
  return Response.json({
    rate_limit: {
      primary_window: { used_percent: used, limit_window_seconds: 18_000, reset_at: 1000 },
    },
    additional_rate_limits: [
      {
        limit_name: "GPT-Special",
        metered_feature: "special",
        rate_limit: {
          secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: 2000 },
        },
      },
    ],
  });
}

function setup() {
  let stored: Credential | undefined = credential();
  const getAuth = vi.fn<() => Promise<AuthResult | undefined>>().mockResolvedValue(AUTH);
  const fetchUsage = vi.fn<typeof fetch>().mockImplementation(async () => response());
  const service = new ProviderUsageService({ getAuth: () => getAuth() }, () => stored, fetchUsage);
  return {
    service,
    getAuth,
    fetchUsage,
    setCredential: (next: Credential | undefined) => (stored = next),
  };
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T10:00:00Z"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("API clients and subscribers share authentication, fetches and the minute budget", async () => {
  const { service, getAuth, fetchUsage } = setup();
  let finishAuth!: (value: AuthResult | undefined) => void;
  getAuth.mockImplementation(() => new Promise((resolve) => (finishAuth = resolve)));
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = service.subscribe(first);
  const stopSecond = service.subscribe(second);
  const requests = Array.from({ length: 8 }, () => service.getUsage(PROVIDER, "gpt-special"));
  expect(getAuth).toHaveBeenCalledTimes(1);
  expect(fetchUsage).not.toHaveBeenCalled();
  finishAuth(AUTH);
  await Promise.all(requests);
  expect(fetchUsage).toHaveBeenCalledTimes(1);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(MINUTE - 1);
  await service.getUsage(PROVIDER, "another-model");
  expect(fetchUsage).toHaveBeenCalledTimes(1);
  stopFirst();
  stopSecond();
});

test("snapshots expose all model windows, while API results select the matching model", async () => {
  const { service } = setup();
  const snapshots: ProviderUsageUpdate[] = [];
  const stop = service.subscribe((snapshot) => snapshots.push(snapshot));
  const special = await service.getUsage(PROVIDER, "GPT-SPECIAL");
  expect(special.windows.map((window) => window.id)).toEqual(["primary", "special:secondary"]);
  expect(special.windows[1]).toEqual({
    id: "special:secondary",
    usedPercent: 40,
    windowSeconds: 604_800,
    resetsAt: 2_000_000,
  });
  expect(snapshots[0]?.usage?.windows).toHaveLength(1);
  expect(snapshots[0]?.usage?.modelWindows?.["gpt-special"]).toHaveLength(1);
  expect((await service.getUsage(PROVIDER, "other")).windows).toHaveLength(1);
  stop();
});

test("unchanged refreshes are quiet, but every new subscriber receives the cached snapshot", async () => {
  const { service, fetchUsage } = setup();
  const first = vi.fn();
  const stopFirst = service.subscribe(first);
  await settle();
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(fetchUsage).toHaveBeenCalledTimes(2);
  expect(first).toHaveBeenCalledTimes(1);
  const second = vi.fn();
  const stopSecond = service.subscribe(second);
  await settle();
  expect(second).toHaveBeenCalledTimes(1);
  expect(first).toHaveBeenCalledTimes(1);
  expect(fetchUsage).toHaveBeenCalledTimes(2);
  stopFirst();
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(fetchUsage).toHaveBeenCalledTimes(3);
  stopSecond();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(5 * MINUTE);
  expect(fetchUsage).toHaveBeenCalledTimes(3);
});

test("HTTP failures consume the minute budget and retain successful usage with a visible error", async () => {
  const { service, fetchUsage } = setup();
  const snapshots: ProviderUsageUpdate[] = [];
  const stop = service.subscribe((snapshot) => snapshots.push(snapshot));
  await settle();
  const successful = snapshots[0]?.usage;
  fetchUsage.mockResolvedValue(new Response(null, { status: 503, statusText: "Unavailable" }));
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(snapshots.at(-1)).toEqual({
    provider: PROVIDER,
    usage: successful,
    error: "ChatGPT usage request failed: 503 Unavailable",
  });
  await Promise.all(
    Array.from({ length: 10 }, () =>
      expect(service.getUsage(PROVIDER, "other")).rejects.toThrow("503 Unavailable"),
    ),
  );
  expect(fetchUsage).toHaveBeenCalledTimes(2);
  expect(snapshots).toHaveLength(2);
  fetchUsage.mockImplementation(async () => response(30));
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(fetchUsage).toHaveBeenCalledTimes(3);
  expect(snapshots.at(-1)?.error).toBeUndefined();
  expect(snapshots.at(-1)?.usage?.windows[0]?.usedPercent).toBe(30);
  stop();
});

test("initial network and authentication failures are throttled without fabricated usage", async () => {
  const { service, fetchUsage, getAuth } = setup();
  fetchUsage.mockRejectedValue(new Error("Network down"));
  const listener = vi.fn();
  const stop = service.subscribe(listener);
  await settle();
  expect(listener).toHaveBeenLastCalledWith({ provider: PROVIDER, error: "Network down" });
  await expect(service.getUsage(PROVIDER, "other")).rejects.toThrow("Network down");
  expect(fetchUsage).toHaveBeenCalledTimes(1);
  getAuth.mockRejectedValue(new Error("Refresh token revoked"));
  await vi.advanceTimersByTimeAsync(MINUTE);
  await expect(service.getUsage(PROVIDER, "other")).rejects.toThrow("Refresh token revoked");
  expect(listener).toHaveBeenLastCalledWith({ provider: PROVIDER, error: "Refresh token revoked" });
  expect(getAuth).toHaveBeenCalledTimes(2);
  expect(fetchUsage).toHaveBeenCalledTimes(1);
  stop();
});

test("logout clears usage and account switches never reuse another account's successful snapshot", async () => {
  const { service, fetchUsage, setCredential } = setup();
  const listener = vi.fn();
  const stop = service.subscribe(listener);
  await settle();
  setCredential(undefined);
  expect(await service.getUsage(PROVIDER, "other")).toEqual({ windows: [] });
  expect(listener).toHaveBeenLastCalledWith({ provider: PROVIDER, usage: { windows: [] } });
  setCredential(credential("account-b"));
  fetchUsage.mockRejectedValue(new Error("B unavailable"));
  await expect(service.getUsage(PROVIDER, "other")).rejects.toThrow("B unavailable");
  expect(listener).toHaveBeenLastCalledWith({ provider: PROVIDER, error: "B unavailable" });
  setCredential(credential());
  expect((await service.getUsage(PROVIDER, "other")).windows).toHaveLength(1);
  expect(fetchUsage).toHaveBeenCalledTimes(2);
  expect((await service.getUsage("other-provider", "other")).windows).toEqual([]);
  stop();
});

test("an account switch during authentication discards the old result", async () => {
  const { service, getAuth, fetchUsage, setCredential } = setup();
  let finishAuth!: (value: AuthResult | undefined) => void;
  getAuth.mockImplementationOnce(() => new Promise((resolve) => (finishAuth = resolve)));
  const listener = vi.fn();
  const stop = service.subscribe(listener);
  setCredential(credential("account-b"));
  finishAuth(AUTH);
  await settle();
  expect(getAuth).toHaveBeenCalledTimes(2);
  expect(fetchUsage).toHaveBeenCalledTimes(1);
  expect(fetchUsage.mock.calls[0]?.[1]?.headers).toMatchObject({
    "chatgpt-account-id": "account-b",
  });
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
});

test("cached API results are reconciled again if the account changes before delivery", async () => {
  const { service, fetchUsage, setCredential } = setup();
  await service.getUsage(PROVIDER, "other");
  const pending = service.getUsage(PROVIDER, "other");
  setCredential(credential("account-b"));
  fetchUsage.mockImplementation(async () => response(70));
  const listener = vi.fn<(snapshot: ProviderUsageUpdate) => void>();
  const stop = service.subscribe(listener);
  expect((await pending).windows[0]?.usedPercent).toBe(70);
  expect(
    listener.mock.calls.every(([snapshot]) => snapshot.usage?.windows[0]?.usedPercent !== 25),
  ).toBe(true);
  expect(fetchUsage).toHaveBeenCalledTimes(2);
  stop();
});

test("subscriber-only account switches reconcile a cached pending result immediately", async () => {
  const { service, fetchUsage, setCredential } = setup();
  await service.getUsage(PROVIDER, "other");
  const stopFirst = service.subscribe(vi.fn());
  setCredential(credential("account-b"));
  fetchUsage.mockImplementation(async () => response(70));
  const second = vi.fn();
  const stopSecond = service.subscribe(second);
  await settle();
  expect(fetchUsage).toHaveBeenCalledTimes(2);
  expect(second.mock.calls.at(-1)?.[0]?.usage?.windows[0]?.usedPercent).toBe(70);
  stopFirst();
  stopSecond();
});

test("new subscribers receive the current account snapshot before an ongoing refresh completes", async () => {
  const { service, fetchUsage } = setup();
  const first = vi.fn();
  const stopFirst = service.subscribe(first);
  await settle();
  let finishFetch!: (value: Response) => void;
  fetchUsage.mockImplementationOnce(() => new Promise((resolve) => (finishFetch = resolve)));
  await vi.advanceTimersByTimeAsync(MINUTE);
  const second = vi.fn();
  const stopSecond = service.subscribe(second);
  expect(second).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenLastCalledWith(first.mock.calls[0]?.[0]);
  finishFetch(response(50));
  await settle();
  expect(second).toHaveBeenCalledTimes(2);
  expect(second.mock.calls[1]?.[0]?.usage?.windows[0]?.usedPercent).toBe(50);
  stopFirst();
  stopSecond();
});

test("missing credentials return empty windows without authentication or provider requests", async () => {
  const { service, getAuth, fetchUsage, setCredential } = setup();
  setCredential(undefined);
  expect(await service.getUsage(PROVIDER, "other")).toEqual({ windows: [] });
  setCredential({ type: "api_key", key: "key" });
  expect(await service.getUsage(PROVIDER, "other")).toEqual({ windows: [] });
  expect(getAuth).not.toHaveBeenCalled();
  expect(fetchUsage).not.toHaveBeenCalled();
});

test("an unavailable OAuth auth result is an error and is cached", async () => {
  const { service, getAuth, fetchUsage } = setup();
  getAuth.mockResolvedValue(undefined);
  await expect(service.getUsage(PROVIDER, "other")).rejects.toThrow("authentication unavailable");
  await expect(service.getUsage(PROVIDER, "other")).rejects.toThrow("authentication unavailable");
  expect(getAuth).toHaveBeenCalledTimes(1);
  expect(fetchUsage).not.toHaveBeenCalled();
});

test("subscriber refresh is scheduled from fetch completion, not the original subscription", async () => {
  const { service, fetchUsage } = setup();
  let finishFetch!: (value: Response) => void;
  fetchUsage.mockImplementationOnce(() => new Promise((resolve) => (finishFetch = resolve)));
  const stop = service.subscribe(vi.fn());
  await settle();
  await vi.advanceTimersByTimeAsync(1000);
  finishFetch(response());
  await settle();
  await vi.advanceTimersByTimeAsync(MINUTE - 1);
  expect(fetchUsage).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetchUsage).toHaveBeenCalledTimes(2);
  expect(fetchUsage.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  stop();
});

test("a stalled provider request times out, publishes its failure and can recover after TTL", async () => {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("Usage timed out")), milliseconds);
    return controller.signal;
  });
  const { service, fetchUsage } = setup();
  fetchUsage.mockImplementationOnce(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason));
      }),
  );
  const listener = vi.fn();
  const stop = service.subscribe(listener);
  await settle();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(listener).toHaveBeenLastCalledWith({ provider: PROVIDER, error: "Usage timed out" });
  await expect(service.getUsage(PROVIDER, "other")).rejects.toThrow("Usage timed out");
  expect(fetchUsage).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(fetchUsage).toHaveBeenCalledTimes(2);
  expect(listener.mock.calls.at(-1)?.[0]?.error).toBeUndefined();
  stop();
});
