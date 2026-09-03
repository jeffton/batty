import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vite-plus/test";
import BasePopover from "./BasePopover.vue";

describe("BasePopover", () => {
  it("renders a native auto popover and exposes its controls", () => {
    const wrapper = mount(BasePopover, {
      attrs: { id: "test-popover" },
      slots: { default: '<div class="scrollable">Content</div>' },
    });
    const element = wrapper.element as HTMLElement;
    const showPopover = vi.fn();
    const hidePopover = vi.fn();
    const togglePopover = vi.fn();
    element.showPopover = showPopover;
    element.hidePopover = hidePopover;
    element.togglePopover = togglePopover;

    wrapper.vm.showPopover();
    wrapper.vm.hidePopover();
    wrapper.vm.togglePopover(true);

    expect(wrapper.element.tagName).toBe("DIV");
    expect(wrapper.attributes()).toMatchObject({ id: "test-popover", popover: "auto" });
    expect(wrapper.find(".scrollable").exists()).toBe(true);
    expect(showPopover).toHaveBeenCalledOnce();
    expect(hidePopover).toHaveBeenCalledOnce();
    expect(togglePopover).toHaveBeenCalledWith(true);
  });

  it("supports form popovers and forwards toggle events", () => {
    const wrapper = mount(BasePopover, { props: { as: "form", mode: "manual" } });
    const toggle = new Event("toggle");

    wrapper.element.dispatchEvent(toggle);

    expect(wrapper.element.tagName).toBe("FORM");
    expect(wrapper.attributes("popover")).toBe("manual");
    expect(wrapper.emitted("toggle")?.[0]?.[0]).toBe(toggle);
  });
});
