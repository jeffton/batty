import { shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import ChatSessionPane from "@/client/components/ChatSessionPane.vue";
import { useAppStore } from "@/client/stores/app";
import type { SessionState, SessionSummary } from "@/shared/types";

const { sendPrompt } = vi.hoisted(() => ({
  sendPrompt: vi.fn(),
}));

vi.mock("@/client/lib/api", () => ({
  abortSession: vi.fn(),
  completeOpenAICodexProviderAuth: vi.fn(),
  createOrOpenDailySession: vi.fn(),
  createSession: vi.fn(),
  createWorkspace: vi.fn(),
  deleteCronJob: vi.fn(),
  getBattyAgentsFile: vi.fn(),
  getBootstrap: vi.fn(),
  getProviderAuthStatus: vi.fn(),
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  getVersion: vi.fn(async () => ({ buildId: "build-1" })),
  listWorkspaceCronJobs: vi.fn(),
  listWorkspaceCronRuns: vi.fn(),
  listWorkspaceSessions: vi.fn(async (): Promise<SessionSummary[]> => []),
  listWorkspaces: vi.fn(async () => []),
  logout: vi.fn(),
  openSession: vi.fn(),
  openSessionById: vi.fn(),
  removeQueuedPrompt: vi.fn(),
  sendPrompt,
  setBattyAgentsFile: vi.fn(),
  setBraveSearchApiKey: vi.fn(),
  setProviderApiKey: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionThinkingLevel: vi.fn(),
  setWorkspaceAssistant: vi.fn(),
  setWorkspacePinned: vi.fn(),
  startOpenAICodexProviderAuth: vi.fn(),
  stopCronRun: vi.fn(),
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

const MessageComposerStub = defineComponent({
  name: "MessageComposer",
  emits: [
    "submit",
    "steer",
    "stop",
    "removeQueuedPrompt",
    "refreshModels",
    "setModel",
    "setThinkingLevel",
  ],
  setup(_props, { emit, expose }) {
    expose({ clear: vi.fn(), restore: vi.fn() });
    return () =>
      h(
        "button",
        {
          class: "submit-prompt",
          type: "button",
          onClick: () => emit("submit", "hello", []),
        },
        "Submit",
      );
  },
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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
    queuedPrompts: [],
    ...overrides,
  };
}

describe("ChatSessionPane", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("does not block sending in another idle session while a previous session send is pending", async () => {
    const pendingSend = deferred();
    sendPrompt.mockReturnValue(pendingSend.promise);
    const store = useAppStore();
    store.activeSession = makeSession("session-a");
    store.selectedWorkspaceId = "batty";

    const wrapper = shallowMount(ChatSessionPane, {
      global: {
        stubs: {
          ChatHeader: true,
          MessageComposer: MessageComposerStub,
          SessionTranscriptView: true,
        },
      },
    });

    await wrapper.get(".submit-prompt").trigger("click");
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenLastCalledWith("web-session-a", "hello", [], undefined);

    store.activeSession = makeSession("session-b");
    await nextTick();
    await wrapper.get(".submit-prompt").trigger("click");

    expect(sendPrompt).toHaveBeenCalledTimes(2);
    expect(sendPrompt).toHaveBeenLastCalledWith("web-session-b", "hello", [], undefined);

    store.activeSession = makeSession("session-a");
    await nextTick();
    await wrapper.get(".submit-prompt").trigger("click");

    expect(sendPrompt).toHaveBeenCalledTimes(2);

    pendingSend.resolve(undefined);
  });
});
