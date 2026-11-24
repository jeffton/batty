import { afterEach, beforeEach, vi } from "vite-plus/test";

vi.mock("@/client/lib/rpc", async () => {
  const { fixtureSessionCall } = await import("@/client/test/session-rpc");
  return {
    rpcCall: vi.fn(fixtureSessionCall),
    closeRpcTransport: vi.fn(),
    isRpcTransportConnecting: () => false,
  };
});
import { createPinia, setActivePinia } from "pinia";
import { type mount } from "@vue/test-utils";
import * as api from "@/client/lib/api";
import { useAppStore } from "./app";
vi.mock("@/client/lib/drafts-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/lib/drafts-db")>()),
  finishSubmission: vi.fn(),
}));

vi.mock("@/client/lib/main-cache", () => ({
  CacheSuspendedError: class CacheSuspendedError extends Error {},
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
import type { BootstrapPayload, SessionState } from "@/shared/types";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("vue-router", () => ({
  useRouter: () => ({ replace, currentRoute: { value: { path: "/login" } } }),
}));
export { replace };
vi.mock("@/client/lib/appearance", () => ({ applyAppAppearance: vi.fn() }));
vi.mock("@/client/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/lib/api")>()),
  getBootstrap: vi.fn(),
  getMain: vi.fn(),
  removeMainQueuedPrompt: vi.fn(),
  logout: vi.fn(),
  submitMainPrompt: vi.fn(),
  listRunningSubagents: vi.fn(),
  listRunningCronRuns: vi.fn(),
  getMemoryStatus: vi.fn(),
}));

export function state(revision = 1, streamId = "generation-a"): SessionState {
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
export const bootstrap = {
  authenticated: true,
  auth: {},
  providerAuth: { providers: [] },
  settings: { braveSearchConfigured: false, appearance: { title: "Batty", color: "neutral" } },
  models: [],
  workspaces: [],
} as unknown as BootstrapPayload;
export const fixture: {
  pinia: ReturnType<typeof createPinia>;
  wrapper?: ReturnType<typeof mount>;
} = { pinia: createPinia() };
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  fixture.pinia = createPinia();
  setActivePinia(fixture.pinia);
  vi.stubGlobal(
    "SessionSubscription",
    class {
      addEventListener() {}
      removeEventListener() {}
      close() {}
    },
  );
  vi.mocked(api.getBootstrap).mockResolvedValue(bootstrap);
  vi.mocked(api.getMain).mockResolvedValue(state());
  vi.mocked(api.listRunningSubagents).mockResolvedValue([]);
  vi.mocked(api.listRunningCronRuns).mockResolvedValue([]);
  vi.mocked(api.logout).mockResolvedValue({ ok: true });
});
afterEach(() => {
  fixture.wrapper?.unmount();
  fixture.wrapper = undefined;
  useAppStore().closeStream();
  vi.unstubAllGlobals();
});
