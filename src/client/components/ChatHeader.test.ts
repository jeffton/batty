import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vite-plus/test";
import ChatHeader from "@/client/components/ChatHeader.vue";

describe("ChatHeader", () => {
  it("places an enabled tools button after cron even without a workspace", () => {
    const wrapper = mount(ChatHeader, {
      props: {
        cronPopoverId: "cron",
        cronPopoverAnchor: "--cron",
        workspaceSwitcherLoading: false,
        connectionState: "online",
      },
      global: { stubs: { CronPopover: true, ToolsPopover: true, SessionHeaderStatus: true } },
    });
    const buttons = wrapper.findAll(".header__icon-btn");
    expect(buttons.map((button) => button.attributes("aria-label"))).toEqual([
      "Cron and subagents",
      "MCPs, skills and tools",
    ]);
    expect(buttons[1]!.attributes("disabled")).toBeUndefined();
    expect(buttons[1]!.attributes("popovertarget")).toBe(
      wrapper.getComponent({ name: "ToolsPopover" }).props("popoverId"),
    );
  });
});
