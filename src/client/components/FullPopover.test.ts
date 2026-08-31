import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vite-plus/test";
import FullPopover from "./FullPopover.vue";

describe("FullPopover", () => {
  it("renders a shared full-popover frame and closes it", async () => {
    const wrapper = mount(FullPopover, {
      props: {
        popoverId: "shared-popover",
        title: "Shared title",
        subtitle: "Shared subtitle",
        closeLabel: "Close shared popover",
      },
      slots: {
        "header-actions": '<button class="custom-action">Action</button>',
        default: '<div class="custom-body">Body</div>',
      },
    });
    const hidePopover = vi.fn();
    (wrapper.element as HTMLElement & { hidePopover: () => void }).hidePopover = hidePopover;

    expect(wrapper.attributes("id")).toBe("shared-popover");
    expect(wrapper.attributes("popover")).toBe("auto");
    expect(wrapper.text()).toContain("Shared title");
    expect(wrapper.text()).toContain("Shared subtitle");
    expect(wrapper.find(".custom-action").exists()).toBe(true);
    expect(wrapper.find(".custom-body").exists()).toBe(true);

    await wrapper.get('[aria-label="Close shared popover"]').trigger("click");
    expect(hidePopover).toHaveBeenCalledOnce();
  });

  it("forwards native toggle events", () => {
    const wrapper = mount(FullPopover, {
      props: { popoverId: "shared-popover", title: "Shared title" },
    });
    const toggle = new Event("toggle") as Event & { newState?: "open" | "closed" };
    toggle.newState = "open";

    wrapper.element.dispatchEvent(toggle);

    expect(wrapper.emitted("toggle")?.[0]?.[0]).toBe(toggle);
  });
});
