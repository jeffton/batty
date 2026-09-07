import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { nextTick } from "vue";
import FullPopover from "./FullPopover.vue";

enableAutoUnmount(afterEach);

async function toggle(wrapper: ReturnType<typeof mount>, newState: "open" | "closed") {
  const event = new Event("toggle");
  Object.assign(event, { newState });
  wrapper.element.dispatchEvent(event);
  await nextTick();
}

function offset(wrapper: ReturnType<typeof mount>) {
  return (wrapper.element as HTMLElement).style.getPropertyValue("--full-popover-stack-offset");
}

describe("FullPopover", () => {
  it("exposes a six-pixel top edge for each level and resets on close and reopen", async () => {
    const popovers = ["parent", "child", "grandchild"].map((popoverId) =>
      mount(FullPopover, { props: { popoverId, title: popoverId } }),
    );
    for (const popover of popovers) await toggle(popover, "open");
    expect(popovers.map(offset)).toEqual(["0px", "6px", "12px"]);

    await toggle(popovers[2]!, "closed");
    expect(popovers.map(offset)).toEqual(["0px", "6px", "0px"]);
    await toggle(popovers[2]!, "open");
    expect(popovers.map(offset)).toEqual(["0px", "6px", "12px"]);

    await toggle(popovers[2]!, "closed");
    await toggle(popovers[1]!, "closed");
    await toggle(popovers[0]!, "closed");
    await toggle(popovers[1]!, "open");
    expect(offset(popovers[1]!)).toBe("0px");
  });

  it("removes unmounted popovers from the stack", async () => {
    const parent = mount(FullPopover, { props: { popoverId: "parent", title: "Parent" } });
    const child = mount(FullPopover, { props: { popoverId: "child", title: "Child" } });
    await toggle(parent, "open");
    await toggle(child, "open");
    expect(offset(child)).toBe("6px");

    parent.unmount();
    await nextTick();
    expect(offset(child)).toBe("0px");
  });

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
