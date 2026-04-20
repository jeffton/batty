import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useAppStore } from "@/client/stores/app";
import type { SessionState, SessionSummary } from "@/shared/types";

const { setWorkspaceAssistant } = vi.hoisted(() => ({
  setWorkspaceAssistant: vi.fn(),
}));

vi.mock("@/client/lib/api", () => ({
  abortSession: vi.fn(),
  completeOpenAICodexProviderAuth: vi.fn(),
  createOrOpenDailySession: vi.fn(),
  createSession: vi.fn(),
  createWorkspace: vi.fn(),
  deleteCronJob: vi.fn(),
  getBootstrap: vi.fn(),
  getProviderAuthStatus: vi.fn(),
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  getVersion: vi.fn(async () => ({ buildId: "build-1" })),
  listWorkspaceCronJobs: vi.fn(),
  listWorkspaceSessions: vi.fn(async (): Promise<SessionSummary[]> => []),
  listWorkspaces: vi.fn(async () => []),
  logout: vi.fn(),
  openSession: vi.fn(),
  sendPrompt: vi.fn(),
  setBraveSearchApiKey: vi.fn(),
  setProviderApiKey: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionThinkingLevel: vi.fn(),
  setWorkspaceAssistant,
  setWorkspacePinned: vi.fn(),
  startOpenAICodexProviderAuth: vi.fn(),
  updateCronJob: vi.fn(),
}));

vi.mock("@/client/lib/cache", () => ({
  readCachedBootstrap: vi.fn(),
  readCachedSession: vi.fn(async () => undefined),
  writeCachedBootstrap: vi.fn(),
  writeCachedSession: vi.fn(async () => undefined),
}));

vi.mock("@/client/lib/agent-notifications", () => ({
  primeAgentNotifications: vi.fn(async () => false),
}));

vi.mock("@/client/lib/push-notifications", () => ({
  syncPushSubscription: vi.fn(async () => undefined),
}));

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void | Promise<void>) | null = null;
  onerror: ((event: Event) => void | Promise<void>) | null = null;
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

function makeSession(sessionId: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: `web-${sessionId}`,
    sessionId,
    workspaceId: "batty",
    cwd: "/root/github/batty",
    path: `/tmp/${sessionId}.jsonl`,
    model: "openai/gpt-5",
    modelLabel: "GPT-5 · openai",
    thinkingLevel: "medium",
    availableThinkingLevels: ["off", "medium"],
    isStreaming: false,
    pendingMessageCount: 0,
    updatedAt: 1,
    contextTokens: 100,
    contextWindow: 1000,
    contextPercent: 10,
    totalMessageCount: 0,
    hasMoreMessages: false,
    messages: [],
    activeTools: [],
    ...overrides,
  };
}

describe("app store session streams", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    MockEventSource.instances = [];
    vi.clearAllMocks();
    vi.stubGlobal("EventSource", MockEventSource);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload: vi.fn() },
    });
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
  });

  it("ignores stale session stream callbacks after switching sessions", async () => {
    const store = useAppStore();
    const sessionA = makeSession("session-a");
    const sessionB = makeSession("session-b");

    store.activeSession = sessionA;
    store.openStream(sessionA);

    const firstStream = MockEventSource.instances[0];
    const staleMessageHandler = firstStream?.onmessage;
    const staleErrorHandler = firstStream?.onerror;

    store.activeSession = sessionB;
    store.openStream(sessionB);

    const secondStream = MockEventSource.instances[1];
    secondStream?.onopen?.(new Event("open"));
    expect(store.connectionState).toBe("online");

    await staleMessageHandler?.({
      data: JSON.stringify({ type: "status", isStreaming: true, pendingMessageCount: 1 }),
    } as MessageEvent<string>);
    await staleErrorHandler?.(new Event("error"));

    expect(store.activeSession?.sessionId).toBe(sessionB.sessionId);
    expect(store.activeSession?.isStreaming).toBe(false);
    expect(store.activeSession?.pendingMessageCount).toBe(0);
    expect(store.connectionState).toBe("online");
  });

  it("applies events from the current session stream", async () => {
    const store = useAppStore();
    const session = makeSession("session-a");

    store.activeSession = session;
    store.openStream(session);

    const stream = MockEventSource.instances[0];
    await stream?.onmessage?.({
      data: JSON.stringify({ type: "status", isStreaming: true, pendingMessageCount: 2 }),
    } as MessageEvent<string>);

    expect(store.activeSession?.sessionId).toBe(session.sessionId);
    expect(store.activeSession?.isStreaming).toBe(true);
    expect(store.activeSession?.pendingMessageCount).toBe(2);
  });

  it("marks one workspace as the assistant", async () => {
    const store = useAppStore();
    store.workspaces = [
      {
        id: "batty",
        label: "batty",
        path: "/root/github/batty",
        kind: "workspace",
        isPinned: false,
        isAssistant: false,
      },
      {
        id: "notes",
        label: "notes",
        path: "/root/github/notes",
        kind: "workspace",
        isPinned: false,
        isAssistant: true,
      },
    ];

    setWorkspaceAssistant.mockResolvedValue([
      {
        id: "batty",
        label: "batty",
        path: "/root/github/batty",
        kind: "workspace",
        isPinned: false,
        isAssistant: true,
      },
      {
        id: "notes",
        label: "notes",
        path: "/root/github/notes",
        kind: "workspace",
        isPinned: false,
        isAssistant: false,
      },
    ]);

    await store.toggleWorkspaceAssistant("batty");

    expect(setWorkspaceAssistant).toHaveBeenCalledWith("batty");
    expect(store.workspaces.find((workspace) => workspace.id === "batty")?.isAssistant).toBe(true);
    expect(store.workspaces.find((workspace) => workspace.id === "notes")?.isAssistant).toBe(false);
  });
});
