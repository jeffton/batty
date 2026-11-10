import { afterEach, expect, test, vi } from "vite-plus/test";

vi.mock("@/client/lib/rpc", async () => {
  const { fixtureSessionCall } = await import("@/client/test/session-rpc");
  return {
    rpcCall: vi.fn(fixtureSessionCall),
    closeRpcTransport: vi.fn(),
    isRpcTransportConnecting: () => false,
  };
});
import { flushPromises, mount } from "@vue/test-utils";
import SubagentSessionPopover from "./SubagentSessionPopover.vue";
import type { SessionState } from "@/shared/types";
import { RpcError } from "@/shared/rpc";
import { getSessionMessages, stopCronRun, stopSubagent } from "@/client/lib/api";
import { rpcCall } from "@/client/lib/rpc";

const session = {
  id: "worker",
  sessionId: "worker",
  workspaceId: "main",
  cwd: "/",
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  isStreaming: false,
  pendingMessageCount: 0,
  updatedAt: 1,
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
  totalMessageCount: 0,
  hasMoreMessages: false,
  messages: [],
  activeTools: [],
  streamId: "generation",
  revision: 1,
} satisfies SessionState;

vi.mock("@/client/lib/api", () => ({
  getSessionMessages: vi.fn(),
  stopSubagent: vi.fn(async () => ({ ok: true })),
  stopCronRun: vi.fn(async () => ({ ok: true })),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("worker connection waits for a snapshot and recovers from offline without accepting late events", async () => {
  vi.useFakeTimers();
  const sources: FakeSource[] = [];
  class FakeSource {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    close = vi.fn();
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    constructor() {
      sources.push(this);
    }
  }
  vi.stubGlobal("SessionSubscription", FakeSource);
  const wrapper = mount(SubagentSessionPopover, {
    props: { popoverId: "worker-popover", sessionId: "worker" },
    global: {
      stubs: {
        FullPopover: {
          name: "FullPopover",
          template: '<div><slot name="header-actions" /><slot /></div>',
        },
        SessionHeaderStatus: true,
        SessionTranscriptView: true,
      },
    },
  });
  const status = () =>
    wrapper.getComponent({ name: "SessionHeaderStatus" }).props("connectionState");
  const snapshot = (source: FakeSource) => {
    source.onmessage!({ data: JSON.stringify({ type: "reset", state: session }) });
  };
  try {
    wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
    await flushPromises();
    expect(status()).toBe("connecting");
    sources[0]!.onopen!();
    await flushPromises();
    expect(status()).toBe("connecting");
    snapshot(sources[0]!);
    await flushPromises();
    expect(status()).toBe("online");
    sources[0]!.onerror!();
    await flushPromises();
    expect(status()).toBe("offline");
    window.dispatchEvent(new Event("pageshow"));
    await flushPromises();
    expect(sources).toHaveLength(2);
    expect(status()).toBe("connecting");
    snapshot(sources[0]!);
    await flushPromises();
    expect(status()).toBe("connecting");
    snapshot(sources[1]!);
    await flushPromises();
    expect(status()).toBe("online");
  } finally {
    wrapper.unmount();
  }
  expect(sources[1]!.close).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("pageshow"));
  vi.advanceTimersByTime(30_000);
  expect(sources).toHaveLength(2);
});

test("a healthy local stream preserves remote offline status and disables actions until reconnection", async () => {
  const sources: { onmessage?: (event: { data: string }) => void }[] = [];
  vi.stubGlobal(
    "SessionSubscription",
    class {
      onmessage?: (event: { data: string }) => void;
      close = vi.fn();
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      constructor() {
        sources.push(this);
      }
    },
  );
  const wrapper = mount(SubagentSessionPopover, {
    props: { popoverId: "remote-popover", sessionId: "remote:mac:123" },
    global: {
      stubs: {
        FullPopover: {
          name: "FullPopover",
          template: '<div><slot name="header-actions" /><slot /></div>',
        },
        SessionHeaderStatus: true,
        SessionTranscriptView: true,
      },
    },
  });
  try {
    wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
    await flushPromises();
    const send = async (offline: boolean, revision: number) => {
      sources[0]!.onmessage!({
        data: JSON.stringify({
          type: "reset",
          state: {
            ...session,
            revision,
            canStopSubagent: true,
            remote: {
              nodeId: "mac",
              connectionState: offline ? "offline" : "online",
              status: "running",
            },
          },
        }),
      });
      await flushPromises();
    };
    await send(true, 2);
    expect(wrapper.getComponent({ name: "SessionHeaderStatus" }).props("connectionState")).toBe(
      "offline",
    );
    expect(wrapper.get('[role="status"]').text()).toContain("Last known: running");
    expect(wrapper.get('[aria-label="Stop subagent"]').attributes("disabled")).toBeDefined();
    await send(false, 3);
    expect(wrapper.getComponent({ name: "SessionHeaderStatus" }).props("connectionState")).toBe(
      "online",
    );
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.get('[aria-label="Stop subagent"]').attributes("disabled")).toBeUndefined();
  } finally {
    wrapper.unmount();
  }
});

test("header stop follows active state, prevents duplicate requests and exposes failures", async () => {
  const sources: FakeSource[] = [];
  class FakeSource {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    close = vi.fn();
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    constructor() {
      sources.push(this);
    }
  }
  vi.stubGlobal("SessionSubscription", FakeSource);
  const wrapper = mount(SubagentSessionPopover, {
    props: { popoverId: "worker-popover", sessionId: "worker" },
    global: {
      stubs: {
        FullPopover: {
          name: "FullPopover",
          template: '<div><header><slot name="header-actions" /></header><slot /></div>',
        },
        SessionHeaderStatus: true,
        SessionTranscriptView: true,
      },
    },
  });
  const snapshot = async (canStopSubagent: boolean, revision: number) => {
    sources[0]!.onmessage!({
      data: JSON.stringify({
        type: "reset",
        state: { ...session, canStopSubagent, revision },
      }),
    });
    await flushPromises();
  };
  try {
    wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
    await flushPromises();
    expect(wrapper.find('[aria-label="Stop subagent"]').exists()).toBe(false);
    await snapshot(true, 2);
    const stop = wrapper.get('header button[aria-label="Stop subagent"]');
    let reject!: (error: Error) => void;
    vi.mocked(stopSubagent).mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    await stop.trigger("click");
    expect(stop.attributes("disabled")).toBeDefined();
    await stop.trigger("click");
    expect(stopSubagent).toHaveBeenCalledExactlyOnceWith("worker");
    reject(new Error("Stop failed"));
    await flushPromises();
    expect(wrapper.get('[role="alert"]').attributes("aria-label")).toBe("Stop failed");
    expect(stop.attributes("disabled")).toBeUndefined();
    await snapshot(false, 3);
    expect(wrapper.find('[aria-label="Stop subagent"]').exists()).toBe(false);
    expect(wrapper.get('[role="alert"]').attributes("aria-label")).toBe("Stop failed");
    await snapshot(true, 4);
    sources[0]!.onerror!();
    await flushPromises();
    expect(wrapper.get('[aria-label="Stop subagent"]').attributes("disabled")).toBeDefined();
  } finally {
    wrapper.unmount();
  }
});

test("cron header stops only the current run and follows completion while viewing its log", async () => {
  const sources: {
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
  }[] = [];
  vi.stubGlobal(
    "SessionSubscription",
    class {
      onmessage?: (event: { data: string }) => void;
      onerror?: () => void;
      close = vi.fn();
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      constructor() {
        sources.push(this);
      }
    },
  );
  const wrapper = mount(SubagentSessionPopover, {
    props: {
      popoverId: "cron-popover",
      sessionId: "cron-session",
      headerTitle: "Cron run",
      cronRun: { runId: "current-run", status: "running" },
    },
    global: {
      stubs: {
        FullPopover: {
          name: "FullPopover",
          template: '<div><header><slot name="header-actions" /></header><slot /></div>',
        },
        SessionHeaderStatus: true,
        SessionTranscriptView: true,
      },
    },
  });
  try {
    wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
    await flushPromises();
    expect(wrapper.get('[aria-label="Stop cron run"]').attributes("disabled")).toBeDefined();
    sources[0]!.onmessage!({
      data: JSON.stringify({ type: "reset", state: { ...session, isCronSession: true } }),
    });
    await flushPromises();
    let reject!: (error: Error) => void;
    vi.mocked(stopCronRun).mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    const stop = wrapper.get('header button[aria-label="Stop cron run"]');
    await stop.trigger("click");
    await stop.trigger("click");
    expect(stopCronRun).toHaveBeenCalledExactlyOnceWith("current-run");
    expect(stopSubagent).not.toHaveBeenCalled();
    expect(stop.attributes("disabled")).toBeDefined();
    reject(new Error("Cron stop failed"));
    await flushPromises();
    expect(wrapper.get('[role="alert"]').attributes("aria-label")).toBe("Cron stop failed");
    expect(stop.attributes("disabled")).toBeUndefined();
    sources[0]!.onerror!();
    await flushPromises();
    expect(stop.attributes("disabled")).toBeDefined();
    await wrapper.setProps({ cronRun: { runId: "current-run", status: "error" } });
    expect(wrapper.find('[aria-label="Stop cron run"]').exists()).toBe(false);
  } finally {
    wrapper.unmount();
  }
});

test("missing local or remote sessions show an empty state, not a connection failure", async () => {
  for (const sessionId of ["deleted-worker", "remote:peer:deleted-worker"]) {
    vi.mocked(rpcCall).mockRejectedValueOnce(new RpcError("NOT_FOUND", "Session not found"));
    const wrapper = mount(SubagentSessionPopover, {
      props: { popoverId: "missing-popover", sessionId },
      global: {
        stubs: {
          FullPopover: {
            name: "FullPopover",
            template: '<div><slot name="header-actions" /><slot /></div>',
          },
          SessionHeaderStatus: true,
          SessionTranscriptView: true,
        },
      },
    });
    wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toBe("This session is no longer available.");
    expect(wrapper.findComponent({ name: "SessionHeaderStatus" }).exists()).toBe(false);
    expect(wrapper.findComponent({ name: "SessionTranscriptView" }).exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  }
});

test("closing during history loading does not lock history after reopening", async () => {
  vi.stubGlobal(
    "SessionSubscription",
    class {
      close = vi.fn();
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
    },
  );
  const historySession = {
    ...session,
    totalMessageCount: 2,
    hasMoreMessages: true,
    messages: [
      { id: "100:0", role: "user", timestamp: 1, blocks: [{ type: "text", text: "recent" }] },
    ] as SessionState["messages"],
  };
  vi.mocked(rpcCall).mockResolvedValueOnce({
    value: {},
    events: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "reset", state: historySession });
      },
    }),
  } as Awaited<ReturnType<typeof rpcCall>>);
  const wrapper = mount(SubagentSessionPopover, {
    props: { popoverId: "history-popover", sessionId: "worker" },
    global: {
      stubs: {
        FullPopover: {
          name: "FullPopover",
          template: '<div><slot name="header-actions" /><slot /></div>',
        },
        SessionHeaderStatus: true,
        SessionTranscriptView: true,
      },
    },
  });
  const toggle = (newState: "open" | "closed") =>
    wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState });
  let finish!: (page: Awaited<ReturnType<typeof getSessionMessages>>) => void;
  vi.mocked(getSessionMessages).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  toggle("open");
  await flushPromises();
  const transcript = wrapper.getComponent({ name: "SessionTranscriptView" });
  const pending = transcript.props("loadOlderMessages")();
  await flushPromises();
  expect(transcript.props("loadingOlderMessages")).toBe(true);
  toggle("closed");
  toggle("open");
  await flushPromises();
  expect(transcript.props("loadingOlderMessages")).toBe(false);
  vi.mocked(getSessionMessages).mockResolvedValueOnce({
    messages: [],
    totalMessageCount: 1,
    hasMoreMessages: false,
  });
  await transcript.props("loadOlderMessages")();
  expect(getSessionMessages).toHaveBeenCalledTimes(2);
  finish({
    messages: [
      { id: "99:0", role: "user", timestamp: 0, blocks: [{ type: "text", text: "stale" }] },
    ],
    totalMessageCount: 3,
    hasMoreMessages: true,
  });
  await pending;
  expect(transcript.props("session").messages.map((message: { id: string }) => message.id)).toEqual(
    ["100:0"],
  );
  wrapper.unmount();
});

test("a deleted session clears a cached transcript when reopened", async () => {
  const close = vi.fn();
  vi.mocked(rpcCall).mockResolvedValueOnce({
    value: {},
    events: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "reset", state: session });
      },
      cancel: close,
    }),
  } as Awaited<ReturnType<typeof rpcCall>>);
  vi.stubGlobal(
    "SessionSubscription",
    class {
      close = close;
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
    },
  );
  const wrapper = mount(SubagentSessionPopover, {
    props: { popoverId: "cached-popover", sessionId: "worker" },
    global: {
      stubs: {
        FullPopover: {
          name: "FullPopover",
          template: '<div><slot name="header-actions" /><slot /></div>',
        },
        SessionHeaderStatus: true,
        SessionTranscriptView: true,
      },
    },
  });
  const toggle = (newState: "open" | "closed") =>
    wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState });
  toggle("open");
  await flushPromises();
  expect(wrapper.findComponent({ name: "SessionTranscriptView" }).exists()).toBe(true);
  toggle("closed");
  vi.mocked(rpcCall).mockRejectedValueOnce(new RpcError("NOT_FOUND", "Session not found"));
  toggle("open");
  await flushPromises();
  expect(wrapper.findComponent({ name: "SessionTranscriptView" }).exists()).toBe(false);
  expect(wrapper.get('[role="status"]').text()).toBe("This session is no longer available.");
  expect(close).toHaveBeenCalled();
  wrapper.unmount();
});

test("server and network errors remain errors, not missing-session empty states", async () => {
  for (const error of [
    new RpcError("INTERNAL", "Server failed"),
    new TypeError("Network failed"),
  ]) {
    vi.mocked(rpcCall).mockRejectedValueOnce(error);
    const wrapper = mount(SubagentSessionPopover, {
      props: { popoverId: "failed-popover", sessionId: "worker" },
      global: {
        stubs: {
          FullPopover: {
            name: "FullPopover",
            template: '<div><slot name="header-actions" /><slot /></div>',
          },
          SessionHeaderStatus: true,
          SessionTranscriptView: true,
        },
      },
    });
    wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
    await flushPromises();
    expect(wrapper.get(".subagent-session-popover__empty--error").text()).toBe(error.message);
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    wrapper.unmount();
  }
});

test.each([
  new DOMException("signal timed out", "TimeoutError"),
  new RpcError("OFFLINE", "RPC socket failed"),
])("recovers initial transport failure %s without a red error or reopening", async (error) => {
  vi.useFakeTimers();
  vi.mocked(rpcCall).mockRejectedValueOnce(error);
  const sources: { onmessage?: (event: { data: string }) => void }[] = [];
  vi.stubGlobal(
    "SessionSubscription",
    class {
      onmessage?: (event: { data: string }) => void;
      close = vi.fn();
      constructor() {
        sources.push(this);
      }
    },
  );
  const wrapper = mount(SubagentSessionPopover, {
    props: { popoverId: "recovery-popover", sessionId: "worker" },
    global: {
      stubs: {
        FullPopover: {
          name: "FullPopover",
          template: '<div><slot name="header-actions" /><slot /></div>',
        },
        SessionHeaderStatus: true,
        SessionTranscriptView: true,
      },
    },
  });
  try {
    wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
    await flushPromises();
    expect(wrapper.text()).not.toContain(error.message);
    expect(wrapper.get('[role="status"]').text()).toBe("Offline — reconnecting…");
    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();
    expect(sources).toHaveLength(1);
    sources[0]!.onmessage!({ data: JSON.stringify({ type: "reset", state: session }) });
    await flushPromises();
    expect(wrapper.findComponent({ name: "SessionTranscriptView" }).exists()).toBe(true);
    expect(wrapper.text()).not.toContain("signal timed out");
    expect(wrapper.getComponent({ name: "SessionHeaderStatus" }).props("connectionState")).toBe(
      "online",
    );
    expect(
      vi
        .mocked(rpcCall)
        .mock.calls.slice(-2)
        .map(([operation]) => operation),
    ).toEqual(["session.watch", "session.watch"]);
  } finally {
    wrapper.unmount();
  }
});
