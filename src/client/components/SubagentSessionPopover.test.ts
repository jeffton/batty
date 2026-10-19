import { afterEach, expect, test, vi } from "vite-plus/test";
import { flushPromises, mount } from "@vue/test-utils";
import SubagentSessionPopover from "./SubagentSessionPopover.vue";
import type { SessionState } from "@/shared/types";
import { stopCronRun, stopSubagent } from "@/client/lib/api";

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
