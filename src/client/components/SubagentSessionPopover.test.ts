import { afterEach, expect, test, vi } from "vite-plus/test";
import { flushPromises, mount } from "@vue/test-utils";
import SubagentSessionPopover from "./SubagentSessionPopover.vue";
import type { SessionState } from "@/shared/types";
import {
  HttpError,
  getSession,
  getSessionMessages,
  stopCronRun,
  stopSubagent,
} from "@/client/lib/api";

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

vi.mock("@/client/lib/api", async (importOriginal) => ({
  HttpError: (await importOriginal<typeof import("@/client/lib/api")>()).HttpError,
  getSession: vi.fn(async () => session),
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
  vi.stubGlobal("EventSource", FakeSource);
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
    await wrapper.vm.$nextTick();
    expect(status()).toBe("connecting");
    snapshot(sources[0]!);
    await wrapper.vm.$nextTick();
    expect(status()).toBe("online");
    sources[0]!.onerror!();
    await wrapper.vm.$nextTick();
    expect(status()).toBe("offline");
    window.dispatchEvent(new Event("pageshow"));
    await wrapper.vm.$nextTick();
    expect(sources).toHaveLength(2);
    expect(status()).toBe("connecting");
    snapshot(sources[0]!);
    await wrapper.vm.$nextTick();
    expect(status()).toBe("connecting");
    snapshot(sources[1]!);
    await wrapper.vm.$nextTick();
    expect(status()).toBe("online");
  } finally {
    wrapper.unmount();
  }
  expect(sources[1]!.close).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("pageshow"));
  vi.advanceTimersByTime(30_000);
  expect(sources).toHaveLength(2);
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
  vi.stubGlobal("EventSource", FakeSource);
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
    await wrapper.vm.$nextTick();
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
    await snapshot(true, 4);
    sources[0]!.onerror!();
    await wrapper.vm.$nextTick();
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
    "EventSource",
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
    await wrapper.vm.$nextTick();
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
    await wrapper.vm.$nextTick();
    expect(stop.attributes("disabled")).toBeDefined();
    await wrapper.setProps({ cronRun: { runId: "current-run", status: "error" } });
    expect(wrapper.find('[aria-label="Stop cron run"]').exists()).toBe(false);
  } finally {
    wrapper.unmount();
  }
});

test("missing local or remote sessions show an empty state, not a connection failure", async () => {
  for (const sessionId of ["deleted-worker", "remote:peer:deleted-worker"]) {
    vi.mocked(getSession).mockRejectedValueOnce(new HttpError("Session not found", 404));
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
    "EventSource",
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
  vi.mocked(getSession).mockResolvedValueOnce(historySession).mockResolvedValueOnce(historySession);
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
  await wrapper.vm.$nextTick();
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
  vi.stubGlobal(
    "EventSource",
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
  vi.mocked(getSession).mockRejectedValueOnce(new HttpError("Session not found", 404));
  toggle("open");
  await flushPromises();
  expect(wrapper.findComponent({ name: "SessionTranscriptView" }).exists()).toBe(false);
  expect(wrapper.get('[role="status"]').text()).toBe("This session is no longer available.");
  expect(close).toHaveBeenCalled();
  wrapper.unmount();
});

test("server and network errors remain errors, not missing-session empty states", async () => {
  for (const error of [new HttpError("Server failed", 500), new TypeError("Network failed")]) {
    vi.mocked(getSession).mockRejectedValueOnce(error);
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
