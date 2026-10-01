import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { describe, expect, it, vi } from "vite-plus/test";
import DeleteButton from "./DeleteButton.vue";

describe("DeleteButton", () => {
  it("anchors a native confirmation popover without deleting on the first click", async () => {
    const wrapper = mount(DeleteButton, {
      props: { label: "Delete item" },
      attrs: { class: "item-delete", title: "Delete" },
    });
    const trigger = wrapper.get('button[aria-label="Delete item"]');
    const popover = wrapper.get("[popover]");
    expect(trigger.classes()).toContain("item-delete");
    expect(trigger.attributes("title")).toBe("Delete");
    expect(trigger.attributes("popovertarget")).toBe(popover.attributes("id"));
    expect(trigger.attributes("style")).toContain("anchor-name: --delete-anchor-");
    expect(popover.attributes("style")).toContain("position-anchor: --delete-anchor-");
    expect(popover.attributes("popover")).toBe("auto");
    await trigger.trigger("click");
    expect(wrapper.emitted("confirm")).toBeUndefined();

    const cancel = wrapper.get('button[aria-label="Cancel"]');
    expect(cancel.attributes("popovertarget")).toBe(popover.attributes("id"));
    expect(cancel.attributes("popovertargetaction")).toBe("hide");
    expect(cancel.attributes("autofocus")).toBeDefined();
    await cancel.trigger("click");
    expect(wrapper.emitted("confirm")).toBeUndefined();

    const hidePopover = vi.fn();
    (popover.element as HTMLElement).hidePopover = hidePopover;
    await wrapper.get('button[aria-label="Confirm: Delete item"]').trigger("click");
    expect(hidePopover).toHaveBeenCalledOnce();
    expect(wrapper.emitted("confirm")).toHaveLength(1);
  });

  it("uses unique anchors and disables both delete buttons", async () => {
    const wrapper = mount(
      defineComponent({
        components: { DeleteButton },
        template: '<DeleteButton label="Delete" disabled /><DeleteButton label="Delete" />',
      }),
    );
    const buttons = wrapper.findAllComponents(DeleteButton);
    const first = buttons[0]!;
    const second = buttons[1]!;
    expect(first.get("[popover]").attributes("id")).not.toBe(
      second.get("[popover]").attributes("id"),
    );
    for (const label of ["Delete", "Confirm: Delete"]) {
      const button = first.get(`button[aria-label="${label}"]`);
      expect(button.attributes("disabled")).toBeDefined();
      await button.trigger("click");
    }
    expect(first.emitted("confirm")).toBeUndefined();
    expect(first.get('button[aria-label="Cancel"]').attributes("disabled")).toBeUndefined();
  });
});
