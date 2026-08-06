import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import SubagentSessionPopover from "./SubagentSessionPopover.vue";
import type { SessionState } from "@/shared/types";

const { abortSession, openSession } = vi.hoisted(() => ({
  abortSession: vi.fn(),
  openSession: vi.fn(),
}));

vi.mock("@/client/lib/api", () => ({
  abortSession,
  getSessionMessages: vi.fn(),
  openSession,
}));

class EventSourceStub {
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  close(): void {}
}

const session: SessionState = {
  id: "web-subagent-1",
  sessionId: "subagent-1",
  workspaceId: "batty",
  cwd: "/root/github/batty",
  path: "/tmp/subagent-1.jsonl",
  model: "openai/gpt-5",
  modelLabel: "GPT-5",
  thinkingLevel: "medium",
  availableThinkingLevels: ["medium"],
  isStreaming: true,
  pendingMessageCount: 0,
  updatedAt: 1,
  contextTokens: 25_000,
  contextWindow: 100_000,
  contextPercent: 25,
  totalMessageCount: 0,
  hasMoreMessages: false,
  messages: [],
  activeTools: [],
};

describe("SubagentSessionPopover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openSession.mockResolvedValue(session);
    abortSession.mockResolvedValue({ ok: true });
    vi.stubGlobal("EventSource", EventSourceStub);
  });

  it("uses one header row with shared session status and a stop control", async () => {
    const wrapper = mount(SubagentSessionPopover, {
      props: {
        popoverId: "subagent-popover",
        workspaceId: "batty",
        sessionPath: session.path!,
      },
      global: {
        stubs: {
          SessionTranscriptView: { template: '<div class="transcript-stub" />' },
        },
      },
    });

    const toggle = new Event("toggle") as Event & { newState?: "open" | "closed" };
    toggle.newState = "open";
    wrapper.get(".subagent-session-popover").element.dispatchEvent(toggle);
    await flushPromises();

    expect(wrapper.find(".subagent-session-popover__status-row").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Streaming live");
    expect(wrapper.text()).not.toContain("Read-only transcript");
    wrapper.get('[aria-label="ctx 25k/100k · 25.0%"]');
    wrapper.get('[aria-label="Stop subagent"]');

    await wrapper.get('[aria-label="Stop subagent"]').trigger("click");
    await flushPromises();

    expect(abortSession).toHaveBeenCalledWith("web-subagent-1");
    expect(wrapper.get('[aria-label="Stop subagent"]').attributes("disabled")).toBeDefined();
  });

  it("shows a stop-request error in the header without hiding the transcript", async () => {
    abortSession.mockRejectedValue(new Error("Could not stop subagent"));
    const wrapper = mount(SubagentSessionPopover, {
      props: {
        popoverId: "subagent-popover",
        workspaceId: "batty",
        sessionPath: session.path!,
      },
      global: {
        stubs: {
          SessionTranscriptView: { template: '<div class="transcript-stub" />' },
        },
      },
    });

    const toggle = new Event("toggle") as Event & { newState?: "open" | "closed" };
    toggle.newState = "open";
    wrapper.get(".subagent-session-popover").element.dispatchEvent(toggle);
    await flushPromises();
    await wrapper.get('[aria-label="Stop subagent"]').trigger("click");
    await flushPromises();

    wrapper.get('[role="alert"][aria-label="Could not stop subagent"]');
    expect(wrapper.find(".transcript-stub").exists()).toBe(true);
    expect(wrapper.get('[aria-label="Stop subagent"]').attributes("disabled")).toBeUndefined();
  });
});
