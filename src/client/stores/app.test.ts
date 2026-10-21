import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import * as api from "@/client/lib/api";
import * as updates from "@/client/lib/app-updates";
import * as cache from "@/client/lib/main-cache";
import * as browserErrors from "@/client/lib/browser-errors";
import App from "@/client/App.vue";
import ChatHeader from "@/client/components/ChatHeader.vue";
import ChatSessionPane from "@/client/components/ChatSessionPane.vue";
import { useAppStore } from "./app";
vi.mock("@/client/lib/main-cache", () => ({
  CacheSuspendedError: class CacheSuspendedError extends Error {},
  CACHE_DAY_MS: 86_400_000,
  CACHE_EPOCH_KEY: "batty:main-cache-epoch",
  REVOKED_CACHE_SCOPE_KEY: "batty:revoked-cache-scope",
  registerMainCacheBootstrap: vi.fn(),
  authorizePreviewCache: vi.fn(),
  readMainCache: vi.fn(),
  saveMainCache: vi.fn(),
  clearMainCache: vi.fn(),
}));
import { applyServerEvent } from "@/client/lib/session-events";
import type { BootstrapPayload, SessionState } from "@/shared/types";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("vue-router", () => ({
  useRouter: () => ({ replace, currentRoute: { value: { path: "/login" } } }),
}));
vi.mock("@/client/lib/appearance", () => ({ applyAppAppearance: vi.fn() }));
vi.mock("@/client/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/lib/api")>()),
  getBootstrap: vi.fn(),
  getMain: vi.fn(),
  listWorkspaces: vi.fn(),
  removeMainQueuedPrompt: vi.fn(),
  logout: vi.fn(),
  submitMainPrompt: vi.fn(),
  listRunningSubagents: vi.fn(),
  listRunningCronRuns: vi.fn(),
  getMemoryStatus: vi.fn(),
}));

function state(revision = 1, streamId = "generation-a"): SessionState {
  return {
    id: "main",
    sessionId: "main",
    workspaceId: "main",
    cwd: "/",
    model: "model-original",
    thinkingLevel: "medium",
    availableThinkingLevels: ["medium"],
    isStreaming: false,
    pendingMessageCount: 0,
    queuedPrompts: [],
    updatedAt: 1,
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    totalMessageCount: 0,
    hasMoreMessages: false,
    messagesDetailLevel: "full",
    messages: [],
    activeTools: [],
    revision,
    streamId,
  };
}
const bootstrap = {
  authenticated: true,
  auth: {},
  providerAuth: { providers: [] },
  settings: { braveSearchConfigured: false, appearance: { title: "Batty", color: "neutral" } },
  models: [],
} as unknown as BootstrapPayload;
let pinia: ReturnType<typeof createPinia>;
let wrapper: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      removeEventListener() {}
      close() {}
    },
  );
  vi.mocked(api.getBootstrap).mockResolvedValue(bootstrap);
  vi.mocked(api.getMain).mockResolvedValue(state());
  vi.mocked(api.listWorkspaces).mockResolvedValue([]);
  vi.mocked(api.listRunningSubagents).mockResolvedValue([]);
  vi.mocked(api.listRunningCronRuns).mockResolvedValue([]);
  vi.mocked(api.logout).mockResolvedValue({ ok: true });
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  useAppStore().closeStream();
  vi.unstubAllGlobals();
});

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

describe("main mutation snapshots", () => {
  it.each(mutations)(
    "does not apply a stale %s HTTP response after SSE progressed",
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

describe("stream recovery", () => {
  it("uses SSE build IDs for background reload checks and retains usage across disconnects", async () => {
    vi.useFakeTimers();
    const check = vi.spyOn(updates, "checkAppUpdate").mockResolvedValue();
    const streams: any[] = [];
    vi.stubGlobal(
      "EventSource",
      class {
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
      streams[0].listeners.get("heartbeat")();
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(check).toHaveBeenCalled();
    expect(check.mock.calls.every(([build]) => build === "server-build")).toBe(true);
    expect(streams).toHaveLength(1);
    streams[0].onerror();
    expect(store.providerUsage).toEqual(usage);
    expect(store.connectionState).toBe("offline");
    store.closeStream();
    check.mockRestore();
    vi.useRealTimers();
  });
  it("replaces auth snapshots on reconnect and applies live updates without transcript changes", () => {
    const streams: any[] = [];
    vi.stubGlobal(
      "EventSource",
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
    expect(store.providerAuthAttempts.p?.completed).toBe(true);
    expect(store.mcpAuthAttempts.m?.status).toBe("completed");
    expect(store.activeSession).toEqual(state());
    emit({ type: "auth-attempts", provider: [], mcp: [] });
    expect(store.providerAuthAttempts).toEqual({});
    expect(store.mcpAuthAttempts).toEqual({});
    expect(store.authAttemptsVersion).toBe(2);
  });
  it.each([
    new Error("Version check failed: 502"),
    new DOMException("The operation timed out", "TimeoutError"),
    new TypeError("Failed to fetch"),
    new Error("App shell check failed: 503"),
  ])("keeps background update failures out of the banner: %s", async (error) => {
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
  it("replaces a silent connection, ignores its late messages and accepts a restart reset", () => {
    vi.useFakeTimers();
    const streams: any[] = [];
    vi.stubGlobal(
      "EventSource",
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
    store.activeSession = { ...state(99), isStreaming: true };
    store.openStream();
    vi.advanceTimersByTime(15_000);
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
      "EventSource",
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
    expect(store.connectionState).toBe("online");
    streams[0].onerror();
    expect(store.connectionState).toBe("offline");
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.connectionState).toBe("connecting");
    streams[0].onmessage({ data: JSON.stringify({ type: "reset", state: state(4) }) });
    expect(store.connectionState).toBe("connecting");
    streams[1].onmessage({ data: JSON.stringify({ type: "reset", state: state(4) }) });
    expect(store.connectionState).toBe("online");
    store.closeStream();
    check.mockRestore();
    vi.useRealTimers();
  });
  it("preserves a fresh SSE connection on pageshow and visibility resume", async () => {
    const check = vi.spyOn(updates, "checkAppUpdate").mockResolvedValue();
    wrapper = mount(App, { global: { plugins: [pinia], stubs: { RouterView: true } } });
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
    wrapper = mount(App, { global: { plugins: [pinia], stubs: { RouterView: true } } });
    await flushPromises();
    const store = useAppStore();
    expect(store.bootstrapped).toBe(false);
    expect(store.bootstrapFailed).toBe(true);
    expect(wrapper.text()).toContain("Network unavailable");
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
    wrapper = mount(ChatHeader, {
      global: {
        plugins: [pinia],
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
    await wrapper.get('button[popover-id="settings-popover"]').trigger("click");
    await flushPromises();
    expect(api.logout).toHaveBeenCalledOnce();
    expect(store.authenticated).toBe(false);
    expect(store.activeSession).toBeUndefined();
  });
});

describe("optimistic prompt reconciliation", () => {
  function mountPane() {
    const store = useAppStore();
    store.activeSession = state();
    store.connectionState = "online";
    const restore = vi.fn();
    const composer = defineComponent({
      name: "MessageComposer",
      props: ["error"],
      emits: ["submit", "removeQueuedPrompt"],
      setup(_, { expose }) {
        expose({ clear: vi.fn(), restore });
      },
      template: "<div>{{ error }}</div>",
    });
    wrapper = mount(ChatSessionPane, {
      global: {
        plugins: [pinia],
        config: { errorHandler: () => {} },
        stubs: { ChatHeader: true, SessionTranscriptView: true, MessageComposer: composer },
      },
    });
    const pending = () =>
      wrapper!.findComponent({ name: "SessionTranscriptView" }).props("optimisticMessages");
    return {
      store,
      restore,
      pending,
      submit: (text: string, files: File[] = []) =>
        wrapper!.findComponent(composer).vm.$emit("submit", text, files),
      removeQueued: (prompt: NonNullable<SessionState["queuedPrompts"]>[number]) =>
        wrapper!.findComponent(composer).vm.$emit("removeQueuedPrompt", prompt),
    };
  }

  it("refreshes running cron status when orchestration changes", async () => {
    const { store } = mountPane();
    await flushPromises();
    expect(api.listRunningCronRuns).toHaveBeenCalledTimes(1);
    store.orchestrationVersion++;
    await flushPromises();
    expect(api.listRunningCronRuns).toHaveBeenCalledTimes(2);
  });

  it("keeps the message after HTTP success, reset and stream state until the matching user message", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.submitMainPrompt>>) => void;
    vi.mocked(api.submitMainPrompt).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { store, pending, submit } = mountPane();
    const file = new File(["image"], "photo.png", { type: "image/png" });
    submit("Look at this", [file]);
    await flushPromises();
    expect(pending()).toHaveLength(1);
    expect(pending()[0].blocks[0].text).toContain("photo.png");
    const clientMessageId = vi.mocked(api.submitMainPrompt).mock.calls[0]![3];
    resolve({ disposition: "started", submissionId: "receipt", sessionId: "main" });
    await flushPromises();
    expect(pending()).toHaveLength(1);
    store.activeSession = applyServerEvent(store.activeSession, {
      type: "reset",
      state: state(2),
      revision: 2,
      streamId: "generation-a",
    });
    await flushPromises();
    expect(pending()).toHaveLength(1);
    store.activeSession = applyServerEvent(store.activeSession, {
      type: "state",
      state: {
        ...state(3),
        queuedPrompts: [{ kind: "followUp", index: 0, text: "Look at this", clientMessageId }],
      },
      revision: 3,
      streamId: "generation-a",
    });
    await flushPromises();
    expect(pending()).toHaveLength(0);
    store.activeSession = { ...state(4), sessionId: "other" };
    await flushPromises();
    expect(pending()).toHaveLength(0);
    store.activeSession = {
      ...state(5),
      queuedPrompts: [{ kind: "followUp", index: 0, text: "Look at this", clientMessageId }],
    };
    await flushPromises();
    expect(pending()).toHaveLength(0);
    const confirmed = {
      ...state(6),
      totalMessageCount: 1,
      messages: [
        {
          role: "user" as const,
          timestamp: 6,
          clientMessageId,
          id: "server-user",
          blocks: [{ type: "text" as const, text: "Look at this" }],
        },
      ],
    };
    store.activeSession = applyServerEvent(store.activeSession, {
      type: "reset",
      state: confirmed,
      revision: 6,
      streamId: "generation-a",
    });
    await flushPromises();
    expect(pending()).toHaveLength(0);
    expect(store.activeSession?.messages).toHaveLength(1);
  });

  it("keeps accepted queued attachments out of the transcript across reload and dispatch", async () => {
    vi.mocked(api.submitMainPrompt).mockResolvedValueOnce({
      disposition: "queued",
      submissionId: "receipt",
      sessionId: "main",
    });
    const first = mountPane();
    first.submit("Persist me", [new File(["image"], "photo.png")]);
    await flushPromises();
    const clientMessageId = vi.mocked(api.submitMainPrompt).mock.calls[0]![3];
    const prompt = {
      kind: "followUp" as const,
      index: 7,
      text: "Persist me\n\nAttached: /uploads/photo.png",
      clientMessageId,
    };
    first.store.activeSession = { ...state(2), queuedPrompts: [prompt] };
    await flushPromises();
    expect(first.pending()).toHaveLength(0);
    wrapper!.unmount();
    const second = mountPane();
    second.store.activeSession = { ...state(2), queuedPrompts: [prompt] };
    await flushPromises();
    expect(second.pending()).toHaveLength(0);
    expect(second.store.activeSession?.queuedPrompts).toEqual([prompt]);
    second.store.activeSession = {
      ...state(3),
      queuedPrompts: [],
      messages: [
        {
          role: "user",
          id: "server",
          timestamp: 3,
          clientMessageId,
          blocks: [{ type: "text", text: "Normalized" }],
        },
      ],
    };
    await flushPromises();
    expect(second.pending()).toHaveLength(0);
    expect(second.store.activeSession?.messages).toHaveLength(1);
    expect(second.store.activeSession?.queuedPrompts).toEqual([]);
  });

  it("drops interrupted prompt uploads on reload rather than reviving filenames as sent messages", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(api.submitMainPrompt).mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const first = mountPane();
    first.submit("Unsent", [new File(["image"], "photo.png")]);
    await flushPromises();
    expect(first.pending()).toHaveLength(1);
    expect(localStorage.getItem("batty:optimistic-messages")).toBeNull();
    wrapper!.unmount();
    // Discard stale entries written by the previous persisted implementation.
    localStorage.setItem("batty:optimistic-messages", JSON.stringify({ main: first.pending() }));
    const second = mountPane();
    await flushPromises();
    expect(second.pending()).toHaveLength(0);
    expect(localStorage.getItem("batty:optimistic-messages")).toBeNull();
    reject(new Error("Interrupted upload"));
    await flushPromises();
    expect(second.pending()).toHaveLength(0);
  });

  it("retires prompt optimism when another tab cancels before the HTTP response arrives", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.submitMainPrompt>>) => void;
    vi.mocked(api.submitMainPrompt).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { store, pending, submit } = mountPane();
    submit("Cancel elsewhere", []);
    await flushPromises();
    const clientMessageId = vi.mocked(api.submitMainPrompt).mock.calls[0]![3];
    store.activeSession = applyServerEvent(store.activeSession, {
      type: "state",
      state: {
        ...state(2),
        queuedPrompts: [{ kind: "followUp", index: 7, text: "Cancel elsewhere", clientMessageId }],
      },
      revision: 2,
      streamId: "generation-a",
    });
    await flushPromises();
    expect(pending()).toHaveLength(0);
    // No local remove action: cancellation is an authoritative SSE update.
    store.activeSession = applyServerEvent(store.activeSession, {
      type: "state",
      state: state(3),
      revision: 3,
      streamId: "generation-a",
    });
    resolve({ disposition: "queued", submissionId: "receipt", sessionId: "main" });
    await flushPromises();
    expect(pending()).toHaveLength(0);
    wrapper!.unmount();
    const reloaded = mountPane();
    await flushPromises();
    expect(reloaded.pending()).toHaveLength(0);
  });

  it("resolves a prompt queue lifecycle missed by SSE from the queued receipt snapshot", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.submitMainPrompt>>) => void;
    vi.mocked(api.submitMainPrompt).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    // Accepted and withdrawn in another tab before this tab saw the inbox.
    vi.mocked(api.getMain).mockResolvedValueOnce(state(4));
    const { pending, submit } = mountPane();
    submit("Already cancelled", []);
    await flushPromises();
    expect(pending()).toHaveLength(1);
    resolve({ disposition: "queued", submissionId: "receipt", sessionId: "main" });
    await flushPromises();
    expect(pending()).toHaveLength(0);
  });

  it("keeps an accepted queue message when only the receipt snapshot acknowledges it", async () => {
    vi.mocked(api.submitMainPrompt).mockResolvedValueOnce({
      disposition: "queued",
      submissionId: "receipt",
      sessionId: "main",
    });
    vi.mocked(api.getMain).mockImplementationOnce(async () => ({
      ...state(4),
      queuedPrompts: [
        {
          kind: "followUp",
          index: 9,
          text: "Snapshot accepted",
          clientMessageId: vi.mocked(api.submitMainPrompt).mock.calls[0]![3],
        },
      ],
    }));
    const { store, pending, submit } = mountPane();
    submit("Snapshot accepted");
    await flushPromises();
    expect(pending()).toHaveLength(0);
    expect(store.activeSession?.queuedPrompts?.[0]?.text).toBe("Snapshot accepted");
  });

  it("keeps a busy prompt only in the queue and removes a cancelled queue item", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.submitMainPrompt>>) => void;
    vi.mocked(api.submitMainPrompt).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { store, pending, submit, removeQueued } = mountPane();
    store.activeSession!.isStreaming = true;
    submit("Next instruction", []);
    await flushPromises();
    expect(api.submitMainPrompt).toHaveBeenCalledWith(
      "prompt",
      "Next instruction",
      [],
      expect.any(String),
    );
    expect(pending()).toHaveLength(0);
    const clientMessageId = vi.mocked(api.submitMainPrompt).mock.calls[0]![3];
    resolve({ disposition: "queued", submissionId: "receipt", sessionId: "main" });
    await flushPromises();
    const prompt = {
      kind: "followUp" as const,
      index: 0,
      text: "Next instruction",
      clientMessageId,
    };
    store.activeSession = { ...state(2), isStreaming: true, queuedPrompts: [prompt] };
    await flushPromises();
    expect(pending()).toHaveLength(0);
    vi.mocked(api.removeMainQueuedPrompt).mockResolvedValueOnce({
      ...state(3),
      isStreaming: true,
    });
    removeQueued(prompt);
    await flushPromises();
    expect(pending()).toHaveLength(0);
  });

  it("shows a busy prompt in the transcript only after dispatch, including reconnect", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.submitMainPrompt>>) => void;
    vi.mocked(api.submitMainPrompt).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { store, pending, submit } = mountPane();
    store.activeSession!.isStreaming = true;
    submit("Dispatch me", []);
    await flushPromises();
    expect(pending()).toHaveLength(0);
    const clientMessageId = vi.mocked(api.submitMainPrompt).mock.calls[0]![3];
    const queued = {
      ...state(2),
      isStreaming: true,
      queuedPrompts: [
        { kind: "followUp" as const, index: 0, text: "Dispatch me", clientMessageId },
      ],
    };
    vi.mocked(api.getMain).mockResolvedValueOnce(queued);
    resolve({ disposition: "queued", submissionId: "receipt", sessionId: "main" });
    await flushPromises();
    expect(pending()).toHaveLength(0);
    expect(store.activeSession?.queuedPrompts).toHaveLength(1);
    const dispatched = {
      ...state(3),
      messages: [
        {
          role: "user" as const,
          id: "server",
          timestamp: 3,
          clientMessageId,
          blocks: [{ type: "text" as const, text: "Dispatch me" }],
        },
      ],
    };
    store.activeSession = applyServerEvent(store.activeSession, {
      type: "reset",
      state: dispatched,
      revision: 3,
      streamId: "reconnected",
    });
    await flushPromises();
    expect(pending()).toHaveLength(0);
    expect(store.activeSession?.messages).toHaveLength(1);
    expect(store.activeSession?.queuedPrompts).toHaveLength(0);
  });

  it("reveals a busy submission if the server actually starts it before SSE arrives", async () => {
    vi.mocked(api.submitMainPrompt).mockResolvedValueOnce({
      disposition: "started",
      submissionId: "receipt",
      sessionId: "main",
    });
    const { store, pending, submit } = mountPane();
    store.activeSession!.isStreaming = true;
    submit("Won the idle race");
    await flushPromises();
    expect(pending()).toHaveLength(1);
  });

  it("hides an idle submission queued by the server even if snapshot recovery fails", async () => {
    vi.mocked(api.submitMainPrompt).mockResolvedValueOnce({
      disposition: "queued",
      submissionId: "receipt",
      sessionId: "main",
    });
    vi.mocked(api.getMain).mockRejectedValueOnce(new Error("Snapshot unavailable"));
    const { pending, submit, restore } = mountPane();
    submit("Lost the idle race");
    await flushPromises();
    expect(pending()).toHaveLength(0);
    expect(restore).not.toHaveBeenCalled();
    expect(wrapper!.text()).toContain("Snapshot unavailable");
  });

  it("shows send errors and restores the text and attachments for retry", async () => {
    vi.mocked(api.submitMainPrompt).mockRejectedValueOnce(new Error("Upload failed"));
    const { pending, restore, submit } = mountPane();
    const files = [new File(["data"], "report.txt")];
    submit("Keep this", files);
    await flushPromises();
    expect(pending()).toHaveLength(0);
    expect(restore).toHaveBeenCalledWith("main", "Keep this", files);
    expect(wrapper!.text()).toContain("Upload failed");
  });
});

describe("restored prompt submission", () => {
  it("does not restore an accepted prompt draft when its HTTP response is lost", async () => {
    const store = useAppStore();
    store.activeSession = state();
    store.connectionState = "online";
    const restore = vi.fn();
    const handleError = vi.fn();
    const composer = defineComponent({
      name: "MessageComposer",
      emits: ["submit"],
      setup(_, { expose }) {
        expose({ clear: vi.fn(), restore });
      },
      template: "<div />",
    });
    vi.mocked(api.submitMainPrompt).mockImplementationOnce(
      async (_kind, _text, _files, clientMessageId) => {
        store.activeSession = {
          ...state(2),
          queuedPrompts: [{ kind: "followUp", index: 0, text: "Accepted", clientMessageId }],
        };
        throw new TypeError("Lost response after acceptance");
      },
    );
    wrapper = mount(ChatSessionPane, {
      global: {
        plugins: [pinia],
        config: { errorHandler: handleError },
        stubs: { ChatHeader: true, SessionTranscriptView: true, MessageComposer: composer },
      },
    });
    wrapper.findComponent(composer).vm.$emit("submit", "Accepted", []);
    await flushPromises();
    expect(restore).not.toHaveBeenCalled();
    expect(handleError).not.toHaveBeenCalled();
  });
  it("retries a transport-failed prompt with the original clientMessageId", async () => {
    const store = useAppStore();
    store.activeSession = state();
    store.connectionState = "online";
    vi.mocked(api.submitMainPrompt)
      .mockRejectedValueOnce(new TypeError("Lost response"))
      .mockResolvedValueOnce({
        disposition: "started",
        submissionId: "receipt",
        sessionId: "main",
      });
    const composer = defineComponent({
      name: "MessageComposer",
      emits: ["submit"],
      setup(_, { expose }) {
        expose({ clear: vi.fn(), restore: vi.fn() });
      },
      template: "<div />",
    });
    wrapper = mount(ChatSessionPane, {
      global: {
        plugins: [pinia],
        config: { errorHandler: () => {} },
        stubs: { ChatHeader: true, SessionTranscriptView: true, MessageComposer: composer },
      },
    });
    const child = wrapper.findComponent(composer);
    child.vm.$emit("submit", "Only once", []);
    await flushPromises();
    const originalId = vi.mocked(api.submitMainPrompt).mock.calls[0]![3];
    child.vm.$emit("submit", "Only once", []);
    await flushPromises();
    expect(api.submitMainPrompt).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.submitMainPrompt).mock.calls[1]![3]).toBe(originalId);
  });
});
