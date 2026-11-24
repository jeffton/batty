import { bootstrap, fixture, replace, state } from "./app-test-fixture";
import { describe, expect, it, vi } from "vite-plus/test";
import { flushPromises } from "@vue/test-utils";
import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import * as api from "@/client/lib/api";
import * as updates from "@/client/lib/app-updates";
import * as cache from "@/client/lib/main-cache";
import App from "@/client/App.vue";
import ChatHeader from "@/client/components/ChatHeader.vue";
import { useAppStore } from "./app";
import { RpcError } from "@/shared/rpc";
import type { BootstrapPayload } from "@/shared/types";
import type { SessionState } from "@/shared/types";

describe("stream recovery", () => {
  it("uses native build events for background reload checks and retains usage across disconnects", async () => {
    vi.useFakeTimers();
    const check = vi.spyOn(updates, "checkAppUpdate").mockResolvedValue();
    const streams: any[] = [];
    vi.stubGlobal(
      "SessionSubscription",
      class {
        static CONNECTING = 0;
        readyState = 1;
        close = vi.fn();
        listeners = new Map<string, () => void>();
        addEventListener(name: string, callback: () => void) {
          this.listeners.set(name, callback);
        }
        removeEventListener(name: string) {
          this.listeners.delete(name);
        }
        constructor() {
          streams.push(this);
        }
      },
    );
    const store = useAppStore();
    store.activeSession = state();
    store.openStream();
    const emit = (event: object) => streams[0].onmessage({ data: JSON.stringify(event) });
    streams[0].onopen();
    expect(check).not.toHaveBeenCalled();
    emit({ type: "build", buildId: "server-build" });
    const usage = {
      provider: "openai-codex",
      usage: {
        windows: [{ id: "primary", usedPercent: 25, windowSeconds: 100, resetsAt: 100_000 }],
      },
    };
    emit({ type: "provider-usage", update: usage });
    for (let i = 0; i < 15; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(check).toHaveBeenCalled();
    expect(check.mock.calls.every(([build]) => build === "server-build")).toBe(true);
    expect(streams).toHaveLength(1);
    streams[0].onerror();
    await flushPromises();
    expect(store.providerUsage).toEqual(usage);
    expect(store.connectionState).toBe("offline");
    store.closeStream();
    check.mockRestore();
    vi.useRealTimers();
  });
  it("replaces auth snapshots on reconnect and applies live updates without transcript changes", async () => {
    const streams: any[] = [];
    vi.stubGlobal(
      "SessionSubscription",
      class {
        addEventListener() {}
        removeEventListener() {}
        close() {}
        constructor() {
          streams.push(this);
        }
      },
    );
    const store = useAppStore();
    store.activeSession = state();
    store.openStream();
    const emit = (event: object) => streams[0].onmessage({ data: JSON.stringify(event) });
    emit({ type: "auth-attempts", provider: [{ attemptId: "p", completed: false }], mcp: [] });
    emit({ type: "provider-auth-attempt", attempt: { attemptId: "p", completed: true } });
    emit({
      type: "mcp-auth-attempt",
      attempt: { attemptId: "m", serverName: "example", status: "completed" },
    });
    await flushPromises();
    expect(store.providerAuthAttempts.p?.completed).toBe(true);
    expect(store.mcpAuthAttempts.m?.status).toBe("completed");
    expect(store.activeSession).toEqual(state());
    emit({ type: "auth-attempts", provider: [], mcp: [] });
    await flushPromises();
    expect(store.providerAuthAttempts).toEqual({});
    expect(store.mcpAuthAttempts).toEqual({});
    expect(store.authAttemptsVersion).toBe(2);
  });
  it("keeps background update failures out of the banner", async () => {
    const error = new Error("Version check failed: 502");
    const check = vi.spyOn(updates, "checkAppUpdate");
    const store = useAppStore();
    check.mockRejectedValueOnce(error);
    await store.checkForUpdates();
    expect(store.lastError).toBeUndefined();
    store.lastError = "Upload failed";
    check.mockRejectedValueOnce(error);
    await store.checkForUpdates();
    expect(store.lastError).toBe("Upload failed");
    check.mockResolvedValueOnce();
    await store.checkForUpdates();
    expect(store.lastError).toBe("Upload failed");
    check.mockRestore();
  });
  it("retries failed bootstrap once the version check reaches the recovered backend", async () => {
    const check = vi.spyOn(updates, "checkAppUpdate").mockResolvedValueOnce();
    const store = useAppStore();
    vi.mocked(api.getBootstrap).mockRejectedValueOnce(new Error("Bootstrap failed: 502"));
    await store.bootstrap();
    expect(store.bootstrapFailed).toBe(true);
    await store.checkForUpdates();
    expect(store.bootstrapFailed).toBe(false);
    expect(store.activeSession?.id).toBe("main");
    expect(store.connectionState).toBe("connecting");
    check.mockRestore();
  });
  it("recovers a suspended connection, ignores its late messages and accepts a restart reset", async () => {
    vi.useFakeTimers();
    const streams: any[] = [];
    vi.stubGlobal(
      "SessionSubscription",
      class {
        static CONNECTING = 0;
        readyState = 1;
        close = vi.fn();
        addEventListener = vi.fn();
        removeEventListener = vi.fn();
        constructor() {
          streams.push(this);
        }
      },
    );
    const store = useAppStore();
    store.activeSession = { ...state(99), isStreaming: true };
    store.openStream();
    await flushPromises();
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(streams).toHaveLength(2);
    expect(streams[0].close).toHaveBeenCalledOnce();
    streams[1].onmessage({
      data: JSON.stringify({
        type: "reset",
        state: state(1, "restart"),
        streamId: "restart",
        revision: 1,
      }),
    });
    streams[0].onmessage({
      data: JSON.stringify({
        type: "reset",
        state: state(100),
        streamId: "generation-a",
        revision: 100,
      }),
    });
    await flushPromises();
    expect(store.activeSession?.streamId).toBe("restart");
    expect(store.activeSession?.isStreaming).toBe(false);
    store.closeStream();
    vi.useRealTimers();
  });
  it("requires a snapshot before declaring a reconnected main stream online", async () => {
    const check = vi.spyOn(updates, "checkAppUpdate").mockResolvedValue();
    vi.useFakeTimers();
    const streams: any[] = [];
    vi.stubGlobal(
      "SessionSubscription",
      class {
        close = vi.fn();
        addEventListener = vi.fn();
        removeEventListener = vi.fn();
        constructor() {
          streams.push(this);
        }
      },
    );
    const store = useAppStore();
    store.activeSession = state();
    store.openStream();
    streams[0].onopen();
    expect(store.connectionState).toBe("connecting");
    streams[0].onmessage({
      data: JSON.stringify({ type: "state", state: {}, streamId: "generation-a", revision: 2 }),
    });
    expect(store.connectionState).toBe("connecting");
    streams[0].onmessage({
      data: JSON.stringify({ type: "reset", state: state(3), revision: 3 }),
    });
    await flushPromises();
    expect(store.connectionState).toBe("online");
    streams[0].onerror();
    await flushPromises();
    expect(store.connectionState).toBe("offline");
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.connectionState).toBe("connecting");
    streams[0].onmessage({ data: JSON.stringify({ type: "reset", state: state(4) }) });
    expect(store.connectionState).toBe("connecting");
    streams[1].onmessage({ data: JSON.stringify({ type: "reset", state: state(4) }) });
    await flushPromises();
    expect(store.connectionState).toBe("online");
    store.closeStream();
    check.mockRestore();
    vi.useRealTimers();
  });
  it("preserves a fresh session socket on pageshow and visibility resume", async () => {
    const check = vi.spyOn(updates, "checkAppUpdate").mockResolvedValue();
    fixture.wrapper = mount(App, {
      global: { plugins: [fixture.pinia], stubs: { RouterView: true } },
    });
    await flushPromises();
    const open = vi.spyOn(useAppStore(), "openStream");
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(open).not.toHaveBeenCalled();
    await flushPromises();
    check.mockRestore();
  });
});

describe("authentication recovery", () => {
  it.each([
    new RpcError("OFFLINE", "Network unavailable"),
    new DOMException("signal timed out", "TimeoutError"),
  ])(
    "keeps background auth probe %s out of the banner but reports server failures",
    async (error) => {
      const store = useAppStore();
      store.authenticated = true;
      store.activeSession = state();
      vi.mocked(api.getBootstrap).mockRejectedValueOnce(error);
      await store.checkAuthentication();
      expect(store.lastError).toBeUndefined();
      vi.mocked(api.getBootstrap).mockRejectedValueOnce(new api.HttpError("Forbidden", 403));
      await store.checkAuthentication();
      expect(store.lastError).toBe("Forbidden");
      await store.checkAuthentication();
      expect(store.lastError).toBeUndefined();
    },
  );

  it("keeps cached bootstrap offline without a background banner, but shows initial-load failures", async () => {
    const store = useAppStore();
    store.bootstrapped = true;
    store.authenticated = true;
    store.activeSession = state();
    vi.mocked(api.getBootstrap).mockRejectedValueOnce(
      new RpcError("OFFLINE", "Network unavailable"),
    );
    await store.bootstrap();
    expect(store.connectionState).toBe("offline");
    expect(store.lastError).toBeUndefined();
    store.activeSession = undefined;
    store.authenticated = false;
    vi.mocked(api.getBootstrap).mockRejectedValueOnce(
      new RpcError("OFFLINE", "Network unavailable"),
    );
    await store.bootstrap();
    expect(store.lastError).toBe("Network unavailable");
  });
  it("keeps the session-stream retry cadence when authentication works but the socket fails", async () => {
    vi.useFakeTimers();
    const streams: { onerror: () => void }[] = [];
    vi.stubGlobal(
      "SessionSubscription",
      class {
        addEventListener() {}
        removeEventListener() {}
        close() {}
        constructor() {
          streams.push(this as unknown as (typeof streams)[number]);
        }
      },
    );
    try {
      const store = useAppStore();
      await store.bootstrap();
      for (let attempt = 0; attempt < 3; attempt++) {
        streams[attempt]!.onerror();
        await flushPromises();
        expect(store.authenticated).toBe(true);
        expect(streams).toHaveLength(attempt + 1);
        expect(api.getMain).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1999);
        expect(streams).toHaveLength(attempt + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(streams).toHaveLength(attempt + 2);
      }
    } finally {
      useAppStore().closeStream();
      vi.useRealTimers();
    }
  });

  it("coalesces slow reconnect auth checks and ignores an expired response from a replaced login", async () => {
    vi.useFakeTimers();
    const streams: { onerror: () => void }[] = [];
    vi.stubGlobal(
      "SessionSubscription",
      class {
        addEventListener() {}
        removeEventListener() {}
        close() {}
        constructor() {
          streams.push(this as unknown as (typeof streams)[number]);
        }
      },
    );
    try {
      const store = useAppStore();
      await store.bootstrap();
      const transcript = store.activeSession;
      let resolve!: (payload: BootstrapPayload) => void;
      vi.mocked(api.getBootstrap).mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      );
      streams[0]!.onerror();
      await vi.advanceTimersByTimeAsync(2000);
      streams[1]!.onerror();
      expect(api.getBootstrap).toHaveBeenCalledTimes(2);
      localStorage.setItem(cache.CACHE_EPOCH_KEY, "replacement-login");
      resolve({ ...bootstrap, authenticated: false });
      await flushPromises();
      expect(store.authenticated).toBe(true);
      expect(store.activeSession).toBe(transcript);
    } finally {
      useAppStore().closeStream();
      vi.useRealTimers();
    }
  });

  it("returns an expired login to the login screen after a session socket disconnect", async () => {
    vi.useFakeTimers();
    const streams: { onerror: () => void; close: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal(
      "SessionSubscription",
      class {
        addEventListener() {}
        removeEventListener() {}
        close = vi.fn();
        constructor() {
          streams.push(this as unknown as (typeof streams)[number]);
        }
      },
    );
    try {
      fixture.wrapper = mount(App, {
        global: { plugins: [fixture.pinia], stubs: { RouterView: true } },
      });
      await flushPromises();
      const store = useAppStore();
      expect(store.authenticated).toBe(true);
      replace.mockClear();
      vi.mocked(cache.clearMainCache).mockClear();
      vi.mocked(api.getBootstrap).mockResolvedValueOnce({ ...bootstrap, authenticated: false });

      // A socket close does not distinguish an expired-cookie 401 from a dropped connection.
      streams[0]!.onerror();
      await flushPromises();
      expect(store.authenticated).toBe(false);
      expect(store.activeSession).toBeUndefined();
      expect(cache.clearMainCache).toHaveBeenCalledOnce();
      expect(replace).toHaveBeenLastCalledWith("/login");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(streams).toHaveLength(1);
      expect(api.getBootstrap).toHaveBeenCalledTimes(2);
    } finally {
      useAppStore().closeStream();
      vi.useRealTimers();
    }
  });

  it("keeps the logged-in transcript when a session reconnect auth check has a network error", async () => {
    let stream!: { onerror: () => void };
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
    const store = useAppStore();
    await store.bootstrap();
    const transcript = store.activeSession;
    vi.mocked(cache.clearMainCache).mockClear();
    vi.mocked(api.getBootstrap).mockRejectedValueOnce(new TypeError("Disconnected"));
    stream.onerror();
    await flushPromises();
    expect(api.getBootstrap).toHaveBeenCalledTimes(2);
    expect(store.authenticated).toBe(true);
    expect(store.activeSession).toBe(transcript);
    expect(store.connectionState).toBe("offline");
    expect(store.lastError).toBe("Disconnected");
    expect(cache.clearMainCache).not.toHaveBeenCalled();
  });

  it("does not accept an authenticated bootstrap response across logout invalidation", async () => {
    let resolve!: (payload: BootstrapPayload) => void;
    vi.mocked(api.getBootstrap).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const store = useAppStore();
    const pending = store.bootstrap();
    await flushPromises();
    localStorage.setItem("batty:main-cache-epoch", "logged-out");
    resolve(bootstrap);
    await pending;
    expect(store.authenticated).toBe(false);
    expect(store.activeSession).toBeUndefined();
    expect(api.getMain).not.toHaveBeenCalled();
  });
  it("does not reopen a stream when main history arrives after logout", async () => {
    let resolve!: (value: SessionState) => void;
    vi.mocked(api.getMain).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const store = useAppStore();
    const pending = store.bootstrap();
    await flushPromises();
    store.authenticated = false;
    localStorage.setItem("batty:main-cache-epoch", "logged-out");
    resolve(state());
    await pending;
    expect(store.activeSession).toBeUndefined();
    expect(store.authenticated).toBe(false);
  });
  it("coalesces concurrent resume and version-check bootstrap recovery", async () => {
    const check = vi.spyOn(updates, "checkAppUpdate").mockResolvedValue();
    let resolve!: (payload: BootstrapPayload) => void;
    vi.mocked(api.getBootstrap).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const store = useAppStore();
    store.bootstrapFailed = true;
    const resumed = store.recoverConnection();
    const version = store.checkForUpdates();
    const concurrent = store.checkForUpdates();
    await flushPromises();
    expect(api.getBootstrap).toHaveBeenCalledOnce();
    resolve(bootstrap);
    await Promise.all([resumed, version, concurrent]);
    expect(store.bootstrapFailed).toBe(false);
    expect(store.authenticated).toBe(true);
    expect(store.activeSession?.id).toBe("main");
    check.mockRestore();
  });
  it("retries an initial bootstrap transport failure on the browser online event", async () => {
    const check = vi.spyOn(updates, "checkAppUpdate").mockResolvedValue();
    vi.mocked(api.getBootstrap).mockRejectedValueOnce(new TypeError("Network unavailable"));
    fixture.wrapper = mount(App, {
      global: { plugins: [fixture.pinia], stubs: { RouterView: true } },
    });
    await flushPromises();
    const store = useAppStore();
    expect(store.bootstrapped).toBe(false);
    expect(store.bootstrapFailed).toBe(true);
    expect(fixture.wrapper.text()).toContain("Network unavailable");
    expect(replace).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("online"));
    await flushPromises();
    expect(api.getBootstrap).toHaveBeenCalledTimes(2);
    expect(store.authenticated).toBe(true);
    expect(store.bootstrapFailed).toBe(false);
    expect(replace).toHaveBeenLastCalledWith("/");
    check.mockRestore();
  });
  it("retains authenticated state during a bootstrap transport failure", async () => {
    const store = useAppStore();
    store.authenticated = true;
    store.bootstrapped = true;
    store.activeSession = state();
    vi.mocked(api.getBootstrap).mockRejectedValueOnce(new TypeError("Disconnected"));
    await store.bootstrap();
    expect(store.authenticated).toBe(true);
    expect(store.activeSession?.id).toBe("main");
  });
  it("handles the SettingsPopover logout event", async () => {
    const store = useAppStore();
    store.authenticated = true;
    store.activeSession = state();
    fixture.wrapper = mount(ChatHeader, {
      global: {
        plugins: [fixture.pinia],
        stubs: {
          SettingsPopover: defineComponent({
            emits: ["logout"],
            template: "<button @click=\"$emit('logout')\">Log out</button>",
          }),
          FullPopover: true,
          ToolsPopover: true,
          CronPopover: true,
          SessionHeaderStatus: true,
        },
      },
    });
    await fixture.wrapper.get('button[popover-id="settings-popover"]').trigger("click");
    await flushPromises();
    expect(api.logout).toHaveBeenCalledOnce();
    expect(store.authenticated).toBe(false);
    expect(store.activeSession).toBeUndefined();
  });
});
