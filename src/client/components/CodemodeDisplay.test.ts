import { mount } from "@vue/test-utils";
import { h } from "vue";
import { describe, expect, it } from "vite-plus/test";
import CodemodeDisplay from "./CodemodeDisplay.vue";
import SubagentSessionPopover from "./SubagentSessionPopover.vue";
import ToolCallBlock from "./ToolCallBlock.vue";

const subagent = { workspaceId: "workspace", sessionPath: "/sessions/child.jsonl" };
const call = { id: "parent/child", name: "subagent", args: "{}", status: "ok", subagent };
const global = { stubs: { SubagentSessionPopover: true } };

function display(calls = [call], allowSessionPopovers = true) {
  return mount(CodemodeDisplay, {
    props: { code: "", blocks: [], compact: false, details: { calls }, allowSessionPopovers },
    global,
  });
}

describe("CodemodeDisplay subagent sessions", () => {
  it.each(["running", "ok", "error", "cancelled"])("opens %s subagent destinations", (status) => {
    const wrapper = display([{ ...call, status }]);
    const popover = wrapper.getComponent(SubagentSessionPopover);
    expect(popover.props()).toMatchObject(subagent);
    expect(wrapper.get("button[popovertarget]").attributes("popovertarget")).toBe(
      popover.props("popoverId"),
    );
    expect(wrapper.get("button[popovertarget]").text()).toBe(
      status === "running" ? "Open live session" : "Open session",
    );
  });

  it("uses distinct stable targets for concurrent calls and component instances", async () => {
    const calls = Array.from({ length: 9 }, () => ({ ...call, id: "parent/?" }));
    const wrapper = display(calls);
    const targets = () =>
      wrapper.findAll("button[popovertarget]").map((button) => button.attributes("popovertarget"));
    const collapsed = targets();
    expect(new Set(collapsed).size).toBe(8);
    const pair = mount(
      {
        render: () =>
          h(
            "div",
            [0, 1].map(() =>
              h(CodemodeDisplay, {
                code: "",
                blocks: [],
                compact: false,
                details: { calls: [call] },
              }),
            ),
          ),
      },
      { global },
    );
    const pairTargets = pair
      .findAll("button[popovertarget]")
      .map((button) => button.attributes("popovertarget"));
    expect(new Set(pairTargets).size).toBe(2);
    await wrapper.get(".tool-call__expand-btn").trigger("click");
    expect(targets().slice(1)).toEqual(collapsed);
  });

  it("only exposes subagent calls with destinations when popovers are allowed", () => {
    expect(display([call], false).find("button[popovertarget]").exists()).toBe(false);
    expect(
      display([{ ...call, name: "read" }])
        .find("button[popovertarget]")
        .exists(),
    ).toBe(false);
    expect(
      display([{ ...call, subagent: { workspaceId: "workspace", sessionPath: "" } }])
        .find("button[popovertarget]")
        .exists(),
    ).toBe(false);
  });

  it("respects the enclosing ToolCallBlock popover setting", () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "codemode",
        arguments: { code: "" },
        resultDetails: { calls: [call] },
        allowSessionPopovers: false,
      },
      global,
    });
    expect(wrapper.find("button[popovertarget]").exists()).toBe(false);
  });
});
