import { bootstrap, fixture, state } from "./app-test-fixture";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { flushPromises } from "@vue/test-utils";
import { mount } from "@vue/test-utils";
import * as api from "@/client/lib/api";
import * as updates from "@/client/lib/app-updates";
import * as cache from "@/client/lib/main-cache";
import * as browserErrors from "@/client/lib/browser-errors";
import * as pushNotifications from "@/client/lib/push-notifications";
import App from "@/client/App.vue";
import { useAppStore } from "./app";
import { RpcError } from "@/shared/rpc";
import type { SessionState } from "@/shared/types";

const mutations = ["queue"] as const;
function mutate(_kind: (typeof mutations)[number]) {
  const store = useAppStore();
  return store.removeQueuedPrompt("followUp", 0);
}
function deferResponse(_kind: (typeof mutations)[number]) {
  let resolve!: (state: SessionState) => void;
  const promise = new Promise<SessionState>((done) => {
    resolve = done;
  });
  vi.mocked(api.removeMainQueuedPrompt).mockReturnValueOnce(promise);
  return resolve;
}
describe("caught cache diagnostics", () => {
  it("reports write aborts while preserving the visible cache failure", async () => {
    const report = vi.spyOn(browserErrors, "reportBrowserError").mockImplementation(() => {});
    const store = useAppStore();
    await store.bootstrap();
    const error = new Error("Cache transaction aborted: write");
    vi.mocked(cache.saveMainCache).mockRejectedValueOnce(error);
    await store.persistMainCache();
    expect(report).toHaveBeenCalledWith(error, "cache-write");
    expect(store.lastError).toContain("Cache transaction aborted: write");
    report.mockRestore();
  });
  it("keeps diagnostics for owned suspension, clears recovered cache errors only", async () => {
    const report = vi.spyOn(browserErrors, "reportBrowserError").mockImplementation(() => {});
    const store = useAppStore();
    await store.bootstrap();
    const failure = new Error("Cache transaction aborted: write");
    vi.mocked(cache.saveMainCache).mockRejectedValueOnce(failure);
    await store.persistMainCache();
    const cancellation = new cache.CacheSuspendedError();
    vi.mocked(cache.saveMainCache).mockRejectedValueOnce(cancellation);
    await store.persistMainCache();
    expect(store.lastError).toContain(failure.message);
    expect(report).toHaveBeenCalledWith(cancellation, "cache-write");
    await store.persistMainCache();
    expect(store.lastError).toBeUndefined();
    vi.mocked(cache.saveMainCache).mockRejectedValueOnce(failure);
    await store.persistMainCache();
    store.lastError = "Unrelated server failure";
    await store.persistMainCache();
    expect(store.lastError).toBe("Unrelated server failure");
    vi.mocked(cache.saveMainCache).mockRejectedValueOnce(cancellation);
    await store.persistMainCache();
    expect(store.lastError).toBe("Unrelated server failure");
    report.mockRestore();
  });
  it("reports read aborts after authenticated bootstrap, without an extra bootstrap request", async () => {
    const report = vi.spyOn(browserErrors, "reportBrowserError").mockImplementation(() => {});
    const error = new Error("Cache transaction aborted: read");
    vi.mocked(cache.readMainCache).mockRejectedValueOnce(error);
    await useAppStore().bootstrap();
    expect(report).toHaveBeenCalledWith(error, "cache-read");
    expect(api.getBootstrap).toHaveBeenCalledTimes(1);
    report.mockRestore();
  });
});

describe("push synchronization recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defers hidden synchronization and recovers its aborted fetch on resume", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const sync = vi
      .spyOn(pushNotifications, "syncPushSubscription")
      .mockRejectedValueOnce(new DOMException("Fetch is aborted", "AbortError"))
      .mockResolvedValue(true);
    const store = useAppStore();
    store.authenticated = true;
    store.bootstrapped = true;
    store.activeSession = state();
    await store.syncNotifications();
    expect(sync).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await store.syncNotifications();
    expect(store.lastError).toBe("Push notifications: Fetch is aborted");
    await store.recoverConnection();
    await flushPromises();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(store.lastError).toBeUndefined();
    expect(store.activeSession?.sessionId).toBe("main");
  });

  it("retries when a pre-suspension request fails after recovery has already started", async () => {
    let reject!: (error: Error) => void;
    const sync = vi
      .spyOn(pushNotifications, "syncPushSubscription")
      .mockReturnValueOnce(
        new Promise((_, fail) => {
          reject = fail;
        }),
      )
      .mockResolvedValue(true);
    const store = useAppStore();
    store.authenticated = true;
    store.bootstrapped = true;
    store.activeSession = state();
    const pending = store.syncNotifications();
    await store.recoverConnection();
    await store.recoverConnection();
    expect(sync).toHaveBeenCalledOnce();
    reject(new DOMException("Fetch is aborted", "AbortError"));
    await pending;
    await flushPromises();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(store.lastError).toBeUndefined();
  });

  it("resyncs after a reconnect snapshot without a banner for transport loss", async () => {
    const error = new RpcError("OFFLINE", "RPC socket failed");
    let stream!: { onmessage: (event: { data: string }) => void };
    vi.stubGlobal(
      "SessionSubscription",
      class {
        close() {}
        constructor() {
          stream = this as unknown as typeof stream;
        }
      },
    );
    const sync = vi
      .spyOn(pushNotifications, "syncPushSubscription")
      .mockRejectedValueOnce(error)
      .mockResolvedValue(true);
    const store = useAppStore();
    store.authenticated = true;
    store.activeSession = state();
    store.lastError = "Message submission failed";
    await store.syncNotifications();
    expect(store.lastError).toBe("Message submission failed");
    store.openStream();
    const reset = () =>
      stream.onmessage({
        data: JSON.stringify({ type: "reset", state: state(), revision: 1 }),
      });
    reset();
    await flushPromises();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(store.lastError).toBe("Message submission failed");
    reset();
    await flushPromises();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it.each([
    new Error("HTTP 500"),
    new RpcError("UNAUTHORIZED", "Sign in required"),
    new DOMException("signal timed out", "TimeoutError"),
  ])(
    "retains real failure %s and does not clear unrelated errors after successful sync",
    async (error) => {
      const sync = vi
        .spyOn(pushNotifications, "syncPushSubscription")
        .mockRejectedValueOnce(error)
        .mockResolvedValue(true);
      const store = useAppStore();
      store.authenticated = true;
      await store.syncNotifications();
      expect(store.lastError).toBe(`Push notifications: ${error.message}`);
      store.lastError = "Message submission failed";
      await store.syncNotifications();
      expect(store.lastError).toBe("Message submission failed");
      expect(sync).toHaveBeenCalledTimes(2);
    },
  );

  it("coalesces concurrent recovery and ignores results from a replaced auth epoch", async () => {
    let reject!: (error: Error) => void;
    const sync = vi.spyOn(pushNotifications, "syncPushSubscription").mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    const store = useAppStore();
    store.authenticated = true;
    const first = store.syncNotifications();
    const second = store.syncNotifications();
    expect(sync).toHaveBeenCalledOnce();
    localStorage.setItem(cache.CACHE_EPOCH_KEY, "new-account");
    reject(new Error("Old request failed"));
    await Promise.all([first, second]);
    expect(store.lastError).toBeUndefined();
  });
});

describe("reading history lifecycle", () => {
  const message = (id: string) => ({
    id,
    role: "user" as const,
    timestamp: Date.now(),
    blocks: [{ type: "text" as const, text: id }],
  });
  const history = () => ({
    ...state(),
    hasMoreMessages: true,
    totalMessageCount: 2,
    messages: [message("new")],
  });
  afterEach(() => vi.restoreAllMocks());

  it("caches successive server pages without expanding the live transcript", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const fetch = vi
      .spyOn(api, "getMainMessages")
      .mockResolvedValueOnce({
        messages: [message("middle")],
        totalMessageCount: 3,
        hasMoreMessages: true,
      })
      .mockResolvedValueOnce({
        messages: [message("old")],
        totalMessageCount: 3,
        hasMoreMessages: false,
      });
    vi.mocked(api.getMain).mockResolvedValue({ ...history(), totalMessageCount: 3 });
    const store = useAppStore();
    await store.bootstrap();
    await flushPromises();
    expect(fetch.mock.calls.map(([options]) => options.before)).toEqual(["new", "middle"]);
    expect(store.activeSession?.messages.map((entry) => entry.id)).toEqual(["new"]);
    expect(cache.saveMainCache).toHaveBeenCalledWith(
      bootstrap,
      expect.objectContaining({ messages: [message("new")] }),
      [message("middle")],
      { before: "new", hasMoreMessages: true },
    );
    expect(cache.saveMainCache).toHaveBeenCalledWith(
      bootstrap,
      expect.anything(),
      [message("old")],
      { before: "middle", hasMoreMessages: false },
    );
  });

  it("pages cached history offline without a network request", async () => {
    const fetch = vi.spyOn(api, "getMainMessages");
    const store = useAppStore();
    store.activeSession = history();
    store.connectionState = "offline";
    vi.mocked(cache.readMainCachePage).mockResolvedValueOnce({
      messages: [message("old")],
      totalMessageCount: 2,
      hasMoreMessages: false,
    });
    await store.loadOlderMessages();
    expect(fetch).not.toHaveBeenCalled();
    expect(store.activeSession.messages.map((entry) => entry.id)).toEqual(["old", "new"]);
    expect(store.activeSession.hasMoreMessages).toBe(false);
  });

  it("keeps a cache gap visible offline instead of skipping missing history", async () => {
    const fetch = vi.spyOn(api, "getMainMessages");
    const store = useAppStore();
    store.activeSession = history();
    store.connectionState = "offline";
    vi.mocked(cache.readMainCachePage).mockResolvedValueOnce(undefined);
    await store.loadOlderMessages();
    expect(fetch).not.toHaveBeenCalled();
    expect(store.activeSession.messages.map((entry) => entry.id)).toEqual(["new"]);
    expect(store.activeSession.hasMoreMessages).toBe(true);
    expect(store.lastError).toBe("This history is not available offline");
  });

  it("does not start background fetches while hidden and resumes from the current boundary", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const fetch = vi.spyOn(api, "getMainMessages").mockResolvedValue({
      messages: [message("old")],
      totalMessageCount: 2,
      hasMoreMessages: false,
    });
    const store = useAppStore();
    store.authenticated = true;
    store.bootstrapped = true;
    store.activeSession = history();
    await store.populateReadingCache();
    expect(fetch).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await store.recoverConnection();
    await flushPromises();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0].before).toBe("new");
    expect(store.activeSession.messages.map((message) => message.id)).toEqual(["new"]);
  });

  it("cancels on suspension, coalesces resume and ignores a late page from the cancelled request", async () => {
    const checkForUpdates = vi.spyOn(updates, "checkAppUpdate").mockResolvedValue();
    try {
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      let resolve!: (page: Awaited<ReturnType<typeof api.getMainMessages>>) => void;
      const fetch = vi.spyOn(api, "getMainMessages").mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      );
      vi.mocked(api.getMain).mockResolvedValue(history());
      fixture.wrapper = mount(App, {
        global: { plugins: [fixture.pinia], stubs: { RouterView: true } },
      });
      await flushPromises();
      const store = useAppStore();
      const signal = fetch.mock.calls[0]![0].signal!;
      await store.populateReadingCache();
      expect(fetch).toHaveBeenCalledOnce();
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(signal.aborted).toBe(true);
      fetch.mockResolvedValue({
        messages: [message("old")],
        totalMessageCount: 2,
        hasMoreMessages: false,
      });
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pageshow"));
      await flushPromises();
      expect(fetch).toHaveBeenCalledTimes(2);
      resolve({ messages: [message("stale")], totalMessageCount: 99, hasMoreMessages: false });
      await flushPromises();
      expect(store.activeSession?.messages.map((message) => message.id)).toEqual(["new"]);
      expect(store.lastError).toBeUndefined();
      expect(checkForUpdates).toHaveBeenCalled();
    } finally {
      checkForUpdates.mockRestore();
    }
  });

  it("recovers through a session reset event and does not duplicate an in-flight history request", async () => {
    let stream: { onmessage: (event: { data: string }) => void };
    vi.stubGlobal(
      "SessionSubscription",
      class {
        addEventListener() {}
        removeEventListener() {}
        close() {}
        constructor() {
          stream = this as unknown as typeof stream;
        }
      },
    );
    const fetch = vi.spyOn(api, "getMainMessages").mockRejectedValueOnce(new Error("HTTP 500"));
    const store = useAppStore();
    store.authenticated = true;
    store.activeSession = history();
    store.openStream();
    await store.populateReadingCache();
    expect(store.lastError).toContain("HTTP 500");
    let resolve!: (page: Awaited<ReturnType<typeof api.getMainMessages>>) => void;
    fetch.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const reset = () =>
      stream!.onmessage({
        data: JSON.stringify({
          type: "reset",
          state: history(),
          streamId: "generation-a",
          revision: 1,
        }),
      });
    reset();
    reset();
    await flushPromises();
    expect(fetch).toHaveBeenCalledTimes(2);
    resolve({ messages: [message("old")], totalMessageCount: 2, hasMoreMessages: false });
    await flushPromises();
    expect(store.activeSession?.messages.map((message) => message.id)).toEqual(["new"]);
    expect(store.lastError).toBeUndefined();
  });

  it("keeps real failures visible and clears only the owned error after recovery", async () => {
    const error = new DOMException("Fetch is aborted", "AbortError");
    const fetch = vi.spyOn(api, "getMainMessages").mockRejectedValueOnce(error);
    const store = useAppStore();
    store.authenticated = true;
    store.activeSession = history();
    await store.populateReadingCache();
    expect(store.lastError).toBe(`Reading history: ${String(error)}`);
    fetch.mockResolvedValue({
      messages: [message("old")],
      totalMessageCount: 2,
      hasMoreMessages: false,
    });
    await store.populateReadingCache();
    expect(store.lastError).toBeUndefined();
    store.activeSession = history();
    fetch.mockRejectedValueOnce(error);
    await store.populateReadingCache();
    store.lastError = "Unrelated failure";
    await store.populateReadingCache();
    expect(store.lastError).toBe("Unrelated failure");
  });

  it.each([
    new RpcError("OFFLINE", "RPC socket failed"),
    new DOMException("signal timed out", "TimeoutError"),
  ])(
    "recovers background history from %s while keeping explicit read failures visible",
    async (error) => {
      const fetch = vi.spyOn(api, "getMainMessages").mockRejectedValueOnce(error);
      const store = useAppStore();
      store.authenticated = true;
      store.activeSession = history();
      await store.populateReadingCache();
      expect(store.lastError).toBeUndefined();
      fetch.mockResolvedValueOnce({
        messages: [message("old")],
        totalMessageCount: 2,
        hasMoreMessages: false,
      });
      await store.populateReadingCache();
      expect(fetch).toHaveBeenCalledTimes(2);
      fetch.mockRejectedValueOnce(error);
      store.connectionState = "online";
      await store.loadOlderMessages();
      expect(store.lastError).toBe(error.message);
    },
  );

  it("does not report owned cancellation or merge a response after the auth epoch changes", async () => {
    let reject!: (error: unknown) => void;
    const fetch = vi.spyOn(api, "getMainMessages").mockImplementationOnce(
      ({ signal }) =>
        new Promise((_, fail) => {
          reject = fail;
          signal!.addEventListener("abort", () =>
            reject(new DOMException("Fetch is aborted", "AbortError")),
          );
        }),
    );
    const store = useAppStore();
    store.authenticated = true;
    store.activeSession = history();
    const pending = store.populateReadingCache();
    store.pauseReadingCache();
    await pending;
    expect(store.lastError).toBeUndefined();
    let resolve!: (page: Awaited<ReturnType<typeof api.getMainMessages>>) => void;
    fetch.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const stale = store.populateReadingCache();
    localStorage.setItem(cache.CACHE_EPOCH_KEY, "replacement-account");
    resolve({ messages: [message("other-account")], totalMessageCount: 2, hasMoreMessages: false });
    await stale;
    expect(store.activeSession?.messages.map((message) => message.id)).toEqual(["new"]);
  });
});

describe("main mutation snapshots", () => {
  it.each(mutations)(
    "does not apply a stale %s RPC response after session events progressed",
    async (kind) => {
      const store = useAppStore();
      store.activeSession = state(5);
      const resolve = deferResponse(kind);
      const work = mutate(kind);
      store.activeSession = { ...state(8), model: "model-live" };
      resolve({ ...state(6), model: "model-stale" });
      await work;
      expect(store.activeSession?.revision).toBe(8);
      expect(store.activeSession?.model).toBe("model-live");
    },
  );
  it.each(mutations)(
    "rejects a %s response from a replaced stream even with a larger revision",
    async (kind) => {
      const store = useAppStore();
      store.activeSession = state(5);
      const resolve = deferResponse(kind);
      const work = mutate(kind);
      store.activeSession = state(1, "generation-b");
      resolve(state(99));
      await work;
      expect(store.activeSession?.streamId).toBe("generation-b");
      expect(store.activeSession?.revision).toBe(1);
    },
  );
  it("accepts an equal-revision authoritative response in the current stream", async () => {
    const store = useAppStore();
    store.activeSession = state(5);
    vi.mocked(api.removeMainQueuedPrompt).mockResolvedValueOnce({ ...state(5), model: "chosen" });
    await store.removeQueuedPrompt("followUp", 0);
    expect(store.activeSession?.model).toBe("chosen");
  });
});
