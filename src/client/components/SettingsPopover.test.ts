import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import SettingsPopover from "./SettingsPopover.vue";

describe("SettingsPopover", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("uses the full-popover frame with an explicit close button", async () => {
    const wrapper = mount(SettingsPopover, {
      props: {
        popoverId: "settings-popover",
        anchorName: "--settings-anchor",
      },
    });
    const hidePopover = vi.fn();
    (wrapper.element as HTMLElement & { hidePopover: () => void }).hidePopover = hidePopover;

    expect(wrapper.classes()).toContain("full-popover");
    expect(wrapper.classes()).toContain("settings-popover");
    expect(wrapper.text()).toContain("Settings");
    expect(wrapper.find(".settings-popover__body").exists()).toBe(true);

    await wrapper.get('[aria-label="Close settings"]').trigger("click");
    expect(hidePopover).toHaveBeenCalledOnce();
  });
});
