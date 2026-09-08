import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import ProviderUsageIndicator from "./ProviderUsageIndicator.vue";
import { getProviderUsage } from "@/client/lib/api";

vi.mock("@/client/lib/api", () => ({ getProviderUsage: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

const window = { id: "primary", usedPercent: 25, windowSeconds: 3600, resetsAt: 3600000 };

describe("ProviderUsageIndicator", () => {
  it("centers one window and shows remaining usage and remaining-time pace", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1800000);
    vi.mocked(getProviderUsage).mockResolvedValue({ windows: [window] });
    const wrapper = mount(ProviderUsageIndicator, { props: { model: "openai-codex/gpt-test" } });
    await flushPromises();
    expect(getProviderUsage).toHaveBeenCalledWith("openai-codex", "gpt-test");
    expect(wrapper.get("g").attributes("transform")).toBe("translate(3, 10)");
    expect(wrapper.get(".usage__fill").attributes("width")).toBe("16.5");
    expect(wrapper.get("path").attributes("transform")).toBe("translate(11, 5)");
    const button = wrapper.get("button");
    const popover = wrapper.get("[popover]");
    expect(button.attributes("aria-label")).toBe("Usage limits");
    expect(button.attributes("popovertarget")).toBe(popover.attributes("id"));
    expect(popover.attributes("popover")).toBe("auto");
    expect(popover.text()).toContain("75% remaining");
    expect(popover.text()).toContain("resets");
    expect(wrapper.find("[title]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("centers two stacked windows and hides unavailable usage on model change", async () => {
    vi.mocked(getProviderUsage).mockResolvedValue({
      windows: [window, { ...window, id: "secondary" }],
    });
    const wrapper = mount(ProviderUsageIndicator, { props: { model: "openai-codex/gpt-test" } });
    await flushPromises();
    expect(wrapper.findAll("g").map((row) => row.attributes("transform"))).toEqual([
      "translate(3, 5)",
      "translate(3, 15)",
    ]);
    vi.mocked(getProviderUsage).mockResolvedValue({ windows: [] });
    await wrapper.setProps({ model: "other/model" });
    expect(wrapper.find("svg").exists()).toBe(false);
    await flushPromises();
    expect(wrapper.find("button").exists()).toBe(false);
    expect(wrapper.find("[popover]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("refreshes usage and reports fetch errors", async () => {
    vi.useFakeTimers();
    vi.mocked(getProviderUsage).mockResolvedValue({ windows: [window] });
    const wrapper = mount(ProviderUsageIndicator, { props: { model: "openai-codex/gpt-test" } });
    await flushPromises();
    vi.mocked(getProviderUsage).mockRejectedValue(new Error("Quota endpoint unavailable"));
    await vi.advanceTimersByTimeAsync(60000);
    expect(wrapper.get("[popover]").text()).toContain("Quota endpoint unavailable");
    expect(wrapper.get("button").attributes("aria-label")).toBe("Usage limits unavailable");
    expect(wrapper.find("svg").exists()).toBe(false);
    wrapper.unmount();
  });
});
