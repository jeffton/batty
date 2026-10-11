import { afterEach, expect, test, vi } from "vite-plus/test";
import { flushPromises, mount } from "@vue/test-utils";
import SubagentSessionPopover from "./SubagentSessionPopover.vue";
import type { SessionState } from "@/shared/types";

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
}));

afterEach(() => {
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
