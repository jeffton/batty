import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vite-plus/test";
import ChatTranscript from "@/client/components/ChatTranscript.vue";
import type { TranscriptDisplayEntry } from "@/client/lib/transcript-display";

function replyEntry(): TranscriptDisplayEntry {
  return {
    kind: "message",
    entry: {
      message: {
        id: "assistant-1",
        role: "assistant",
        timestamp: 1,
        blocks: [
          { type: "thinking", thinking: "Checking the result." },
          { type: "text", text: "The result is ready." },
        ],
      },
      toolStatesByCallId: new Map(),
    },
    showTimestamp: false,
    detailsToggleBeforeReply: {
      sectionKey: "turn:user-1",
      expanded: true,
    },
  };
}

describe("ChatTranscript", () => {
  for (const location of ["history", "tail"] as const) {
    it(`renders and emits an inline details toggle before a ${location} reply`, async () => {
      const entry = replyEntry();
      const wrapper = mount(ChatTranscript, {
        props: {
          historyEntries: location === "history" ? [entry] : [],
          tailEntries: location === "tail" ? [entry] : [],
          keptHistoryIndexes: location === "history" ? [0] : [],
          isStreaming: false,
          isPinnedToBottom: true,
        },
      });

      const bodyChildren = Array.from(wrapper.find(".message__body").element.children);
      expect(bodyChildren[1]?.classList.contains("transcript__details-toggle-row")).toBe(true);
      expect(bodyChildren[2]?.classList.contains("message__segment--bubble")).toBe(true);

      await wrapper.get(".transcript__details-toggle-btn").trigger("click");
      expect(wrapper.emitted("toggleDetails")).toEqual([["turn:user-1"]]);
    });
  }
});
