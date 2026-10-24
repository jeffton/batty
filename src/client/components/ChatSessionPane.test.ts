import { expect, test, vi } from "vite-plus/test";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAppStore } from "@/client/stores/app";
import ChatSessionPane from "./ChatSessionPane.vue";
import MessageComposer from "./MessageComposer.vue";
import type { SessionState } from "@/shared/types";

vi.mock("@/client/lib/api", () => ({
  listRunningSubagents: vi.fn().mockResolvedValue([]),
  getMain: vi.fn(),
}));

test("initial main snapshot shows preparation and SSE memory errors without polling", async () => {
  setActivePinia(createPinia());
  const store = useAppStore();
  store.activeSession = {
    sessionId: "main",
    messages: [],
    thinkingLevel: "medium",
    availableThinkingLevels: ["medium"],
    isStreaming: false,
    isCompacting: false,
    memoryPreparation: { pending: 8, totalLeaves: 10, builtLeaves: 2 },
  } as unknown as SessionState;
  const wrapper = mount(ChatSessionPane, {
    global: {
      stubs: {
        BasePopover: { template: "<div><slot /></div>" },
        ChatHeader: true,
        SessionTranscriptView: true,
        ModelConfigSelector: true,
        ComposerQueuedPrompts: true,
      },
    },
  });
  try {
    expect(wrapper.get('button[aria-label="Running tasks"]').text()).toBe("1 task");
    expect(wrapper.find(".streaming-stop-control__status").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Compacting");
    store.activeSession.memoryPreparation = {
      pending: 0,
      totalLeaves: 10,
      builtLeaves: 10,
      error: "Memory failed",
    };
    await wrapper.vm.$nextTick();
    expect(wrapper.getComponent(MessageComposer).props("error")).toBeUndefined();
    expect(wrapper.getComponent(MessageComposer).props("memoryError")).toBe("Memory failed");
    expect(wrapper.get(".tasks-popover__task").text()).toContain("Memory failed");
    expect(wrapper.get(".tasks-popover__task").text()).toContain("Memory preparation failed");
    expect(wrapper.text()).not.toContain("Compacting");
    store.lastError = "Main request failed";
    store.activeSession.memoryPreparation.error = undefined;
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".tasks-control").exists()).toBe(false);
    expect(wrapper.getComponent(MessageComposer).props("error")).toBe("Main request failed");
    expect(wrapper.text()).not.toContain("Memory failed");
  } finally {
    wrapper.unmount();
  }
});
