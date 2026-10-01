import { flushPromises, shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import ChatSessionPane from "@/client/components/ChatSessionPane.vue";
import { useAppStore } from "@/client/stores/app";
import type {
  PromptSubmissionResult,
  RunningSubagent,
  SessionState,
  SessionSummary,
  UiMessage,
} from "@/shared/types";

const { sendPrompt, listRunningSubagents } = vi.hoisted(() => ({
  sendPrompt: vi.fn(),
  listRunningSubagents: vi.fn<(sessionId: string) => Promise<RunningSubagent[]>>(async () => []),
}));

vi.mock("@/client/lib/api", () => ({
  abortSession: vi.fn(),
  completeOpenAIProviderAuth: vi.fn(),
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
  listRunningSubagents,
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
  startOpenAIProviderAuth: vi.fn(),
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

const restoreComposer = vi.fn();
const MessageComposerStub = defineComponent({
  name: "MessageComposer",
  props: {
    error: String,
  },
  emits: [
    "submit",
    "steer",
    "stop",
    "removeQueuedPrompt",
    "refreshModels",
    "setModel",
    "setThinkingLevel",
  ],
  setup(props, { emit, expose }) {
    expose({ clear: vi.fn(), restore: restoreComposer });
    return () =>
      h("div", [
        props.error ? h("p", { class: "prompt-error" }, props.error) : undefined,
        h(
          "button",
          {
            class: "submit-prompt",
            type: "button",
            onClick: () => emit("submit", "hello", []),
          },
          "Submit",
        ),
      ]);
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

const runningSubagent: RunningSubagent = {
  sessionId: "child-a",
  sessionPath: "/tmp/child-a.jsonl",
  workspaceId: "batty",
  parentSessionId: "session-a",
  prompt: "Work",
  model: "openai/gpt-5",
  thinkingLevel: "medium",
  startedAtMs: 1,
};

describe("ChatSessionPane", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("polls subagents while idle and clears activity when they finish", async () => {
    vi.useFakeTimers();
    const store = useAppStore();
    store.activeSession = makeSession("session-a");
    listRunningSubagents.mockResolvedValueOnce([
      runningSubagent,
      { ...runningSubagent, sessionId: "child-b" },
    ]);
    const wrapper = shallowMount(ChatSessionPane);
    try {
      await flushPromises();
      const composer = wrapper.getComponent({ name: "MessageComposer" });
      expect(listRunningSubagents).toHaveBeenCalledWith("session-a");
      expect(composer.props("subagentCount")).toBe(2);
      expect(composer.props("streaming")).toBe(false);

      await vi.advanceTimersByTimeAsync(1_500);
      expect(composer.props("subagentCount")).toBe(0);
      wrapper.unmount();
      const calls = listRunningSubagents.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_500);
      expect(listRunningSubagents).toHaveBeenCalledTimes(calls);
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  it("ignores subagent responses from a previous session", async () => {
    const pending = deferred<RunningSubagent[]>();
    listRunningSubagents.mockReturnValueOnce(pending.promise);
    const store = useAppStore();
    store.activeSession = makeSession("session-a");
    const wrapper = shallowMount(ChatSessionPane);
    try {
      store.activeSession = makeSession("session-b");
      await flushPromises();
      pending.resolve([runningSubagent]);
      await flushPromises();
      expect(wrapper.getComponent({ name: "MessageComposer" }).props("subagentCount")).toBe(0);
      expect(listRunningSubagents).toHaveBeenLastCalledWith("session-b");
    } finally {
      wrapper.unmount();
    }
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

  it("does not show an older send failure after a newer send succeeds", async () => {
    const olderSend = deferred();
    const newerSend = deferred();
    sendPrompt.mockReturnValueOnce(olderSend.promise).mockReturnValueOnce(newerSend.promise);
    const store = useAppStore();
    store.activeSession = makeSession("session-a", { isStreaming: true });
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
    const pane = wrapper.vm as unknown as {
      sendPrompt: (text: string, files: File[]) => Promise<void>;
    };

    const olderResult = pane.sendPrompt("older", []);
    const newerResult = pane.sendPrompt("newer", []);
    newerSend.resolve(undefined);
    await newerResult;
    olderSend.reject(new Error("Older failure"));
    await expect(olderResult).rejects.toThrow("Older failure");
    await nextTick();

    expect(wrapper.find(".prompt-error").exists()).toBe(false);
  });

  it.each([
    ["sendPrompt", "queued"],
    ["sendPrompt", "message"],
    ["sendPrompt", "unrelated"],
    ["steerPrompt", "queued"],
    ["steerPrompt", "message"],
    ["steerPrompt", "unrelated"],
  ] as const)(
    "uses submission identity, not session activity, after a failed %s (%s)",
    async (action, acceptance) => {
      const pendingSend = deferred();
      sendPrompt.mockReturnValue(pendingSend.promise);
      const store = useAppStore();
      store.activeSession = makeSession("session-a");
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
        wrapper.vm as unknown as Record<
          typeof action,
          (text: string, files: File[]) => Promise<void>
        >
      )[action]("hello", []);
      await nextTick();
      const clientMessageId = sendPrompt.mock.calls[0]![3] as string;
      store.activeSession = makeSession("session-a", {
        isStreaming: true,
        pendingMessageCount: 1,
        updatedAt: 2,
        queuedPrompts: [
          {
            kind: "followUp",
            index: 0,
            text: "hello",
            clientMessageId: acceptance === "queued" ? clientMessageId : "other-client",
          },
        ],
        messages: [
          {
            id: "user-1",
            role: "user",
            timestamp: 2,
            blocks: [{ type: "text", text: "hello" }],
            clientMessageId: acceptance === "message" ? clientMessageId : "other-client",
          },
        ],
      });
      pendingSend.reject(new Error("Connection lost"));
      await expect(result).rejects.toThrow("Connection lost");
      if (acceptance === "unrelated") {
        expect(restoreComposer).toHaveBeenCalledWith("session-a", "hello", []);
      } else {
        expect(restoreComposer).not.toHaveBeenCalled();
      }
      wrapper.unmount();
    },
  );

  it("removes an optimistic transcript message when the server acknowledges queue admission", async () => {
    const pendingSend = deferred<PromptSubmissionResult>();
    sendPrompt.mockReturnValue(pendingSend.promise);
    const store = useAppStore();
    store.activeSession = makeSession("session-a");
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
    pendingSend.resolve({
      disposition: "queued",
      entryId: "entry-1",
      clientMessageId: sendPrompt.mock.calls[0]![3] as string,
    });
    await result;
    await nextTick();
    expect(wrapper.get(".optimistic-messages").text()).toBe("");
    expect(restoreComposer).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("reconciles an optimistic message from a queue snapshot before the HTTP receipt", async () => {
    const pendingSend = deferred<PromptSubmissionResult>();
    sendPrompt.mockReturnValue(pendingSend.promise);
    const store = useAppStore();
    store.activeSession = makeSession("session-a");
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
    const clientMessageId = sendPrompt.mock.calls[0]![3] as string;
    store.activeSession.queuedPrompts = [
      { kind: "followUp", index: 0, text: "hello", clientMessageId },
    ];
    await nextTick();
    expect(wrapper.get(".optimistic-messages").text()).toBe("");
    pendingSend.resolve({ disposition: "queued", entryId: "entry-1", clientMessageId });
    await result;
    expect(restoreComposer).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("shows a failed send above the composer and removes its optimistic prompt", async () => {
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

    pendingSend.reject(new Error("Batty is preparing to restart. Try again after restart."));
    await expect(result).rejects.toThrow("Batty is preparing to restart. Try again after restart.");
    await nextTick();

    expect(wrapper.get(".prompt-error").text()).toBe(
      "Batty is preparing to restart. Try again after restart.",
    );
    expect(wrapper.get(".optimistic-messages").text()).toBe("");
  });
});
