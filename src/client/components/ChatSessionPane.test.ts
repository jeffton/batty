import { shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import ChatSessionPane from "@/client/components/ChatSessionPane.vue";
import { useAppStore } from "@/client/stores/app";
import type { SessionState, SessionSummary, UiMessage } from "@/shared/types";

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
  listWorkspaceCronRunLogs: vi.fn(),
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

const SessionTranscriptStub = defineComponent({
  name: "SessionTranscriptView",
  props: {
    optimisticMessages: {
      type: Array as () => UiMessage[],
      default: () => [],
    },
  },
  setup(props) {
    return () =>
      h(
        "div",
        { class: "optimistic-messages" },
        props.optimisticMessages.flatMap((message) =>
          "blocks" in message
            ? message.blocks.map((block) => (block.type === "text" ? block.text : ""))
            : [],
        ),
      );
  },
});

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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
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
          SessionTranscriptView: SessionTranscriptStub,
        },
      },
    });

    await wrapper.get(".submit-prompt").trigger("click");
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenLastCalledWith(
      "web-session-a",
      "hello",
      [],
      expect.any(String),
      undefined,
    );

    store.activeSession = makeSession("session-b");
    await nextTick();
    await wrapper.get(".submit-prompt").trigger("click");

    expect(sendPrompt).toHaveBeenCalledTimes(2);
    expect(sendPrompt).toHaveBeenLastCalledWith(
      "web-session-b",
      "hello",
      [],
      expect.any(String),
      undefined,
    );

    store.activeSession = makeSession("session-a");
    await nextTick();
    await wrapper.get(".submit-prompt").trigger("click");

    expect(sendPrompt).toHaveBeenCalledTimes(2);

    pendingSend.resolve(undefined);
  });

  it("shows an idle prompt optimistically and reconciles it with the server message", async () => {
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
          SessionTranscriptView: SessionTranscriptStub,
        },
      },
    });

    await wrapper.get(".submit-prompt").trigger("click");

    expect(wrapper.get(".optimistic-messages").text()).toBe("hello");
    expect(store.activeSession.messages).toEqual([]);
    const clientMessageId = sendPrompt.mock.calls[0]?.[3] as string;

    const otherUserMessage: Extract<UiMessage, { role: "user" }> = {
      id: "user-other-client",
      role: "user",
      timestamp: Date.now(),
      clientMessageId: crypto.randomUUID(),
      blocks: [{ type: "text", text: "hello" }],
    };
    store.activeSession = makeSession("session-a", { messages: [otherUserMessage] });
    await nextTick();
    expect(wrapper.get(".optimistic-messages").text()).toBe("hello");

    store.activeSession = makeSession("session-a", {
      messages: [
        otherUserMessage,
        {
          id: "user-1",
          role: "user",
          timestamp: Date.now(),
          clientMessageId,
          blocks: [{ type: "text", text: "server-transformed content" }],
        },
      ],
    });
    await nextTick();

    expect(wrapper.get(".optimistic-messages").text()).toBe("");
    pendingSend.resolve(undefined);
  });

  it("does not leave an optimistic message for slash commands", async () => {
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
          SessionTranscriptView: SessionTranscriptStub,
        },
      },
    });

    const result = (
      wrapper.vm as unknown as { sendPrompt: (text: string, files: File[]) => Promise<void> }
    ).sendPrompt("/command", []);
    await nextTick();

    expect(wrapper.get(".optimistic-messages").text()).toBe("");
    pendingSend.resolve(undefined);
    await result;
  });

  it("removes the optimistic prompt when a failed send restores the draft", async () => {
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
          SessionTranscriptView: SessionTranscriptStub,
        },
      },
    });

    const result = (
      wrapper.vm as unknown as { sendPrompt: (text: string, files: File[]) => Promise<void> }
    ).sendPrompt("hello", []);
    await nextTick();
    expect(wrapper.get(".optimistic-messages").text()).toBe("hello");

    pendingSend.reject(new Error("Network error"));
    await expect(result).rejects.toThrow("Network error");
    await nextTick();

    expect(wrapper.get(".optimistic-messages").text()).toBe("");
  });
});
