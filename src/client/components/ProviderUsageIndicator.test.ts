import { mount } from "@vue/test-utils";
import { expect, test, vi } from "vite-plus/test";
import ProviderUsageIndicator from "./ProviderUsageIndicator.vue";
import type { ProviderUsageUpdate } from "@/shared/types";

const update: ProviderUsageUpdate = {
  provider: "openai-codex",
  usage: {
    windows: [
      { id: "primary", usedPercent: 25, windowSeconds: 3600, resetsAt: Date.now() + 3600000 },
    ],
    modelWindows: {
      sol: [{ id: "model", usedPercent: 50, windowSeconds: 3600, resetsAt: Date.now() + 3600000 }],
    },
  },
};

test("usage is event-driven, selects model limits and preserves charts when a provider fails", async () => {
  vi.useFakeTimers();
  const fetch = vi.spyOn(globalThis, "fetch");
  const wrapper = mount(ProviderUsageIndicator, {
    props: { model: "openai-codex/Sol", update },
    global: { stubs: { Teleport: true } },
  });
  try {
    expect(wrapper.findAll(".usage__fill")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).not.toHaveBeenCalled();
    await wrapper.setProps({ update: { ...update, error: "ChatGPT usage request failed: 503" } });
    expect(wrapper.findAll(".usage__fill")).toHaveLength(2);
    expect(wrapper.get(".usage-details__error").text()).toContain("503");
    expect(wrapper.get("button").text()).not.toBe("!");
    await wrapper.setProps({ model: "openai-codex/Luna" });
    expect(wrapper.findAll(".usage__fill")).toHaveLength(1);
    await wrapper.setProps({ model: "other/model" });
    expect(wrapper.find("button").exists()).toBe(false);
  } finally {
    wrapper.unmount();
    fetch.mockRestore();
    vi.useRealTimers();
  }
});
