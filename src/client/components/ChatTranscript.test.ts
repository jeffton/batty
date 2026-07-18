import { shallowMount } from "@vue/test-utils";
import { describe, expect, it } from "vite-plus/test";
import ChatTranscript from "@/client/components/ChatTranscript.vue";

describe("ChatTranscript history loading", () => {
  it("offers an explicit history control when older messages exist", async () => {
    const wrapper = shallowMount(ChatTranscript, {
      props: {
        historyEntries: [],
        tailEntries: [],
        keptHistoryIndexes: [],
        isStreaming: false,
        isPinnedToBottom: true,
        hasMoreMessages: true,
        loadingOlderMessages: false,
      },
    });

    await wrapper.get(".transcript__load-older-btn").trigger("click");

    expect(wrapper.emitted("loadOlderMessages")).toHaveLength(1);
  });
});
