import { mount, shallowMount } from "@vue/test-utils";
import { h } from "vue";
import { describe, expect, it } from "vite-plus/test";
import CodemodeDisplay from "./CodemodeDisplay.vue";
import SubagentSessionPopover from "./SubagentSessionPopover.vue";
import ToolCallBlock from "./ToolCallBlock.vue";

const subagent = { workspaceId: "workspace", sessionPath: "/sessions/child.jsonl" };
const call = { id: "parent/child", name: "subagent", args: "{}", status: "ok", subagent };
const global = { stubs: { SubagentSessionPopover: true } };

function display(
  calls: Array<typeof call & { cost?: number }> = [call],
  allowSessionPopovers = true,
) {
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

describe("canonical SDK summaries and native progress facets", () => {
  it("preserves model spend and subagent destinations alongside unmatched native output", async () => {
    const wrapper = display([
      { ...call, id: "parent/?", status: "running", cost: 0.01 },
      { ...call, id: "parent/?", status: "running", cost: 0.02 },
    ]);
    await wrapper.setProps({
      details: {
        calls: [
          { ...call, id: "parent/?", status: "running", cost: 0.01 },
          { ...call, id: "parent/?", status: "running", cost: 0.02 },
        ],
        nestedCalls: {
          complete: false,
          calls: [
            { id: "parent/1", name: "subagent", status: "unfinished", output: "child progress" },
          ],
        },
      },
    });
    expect(wrapper.findAllComponents(SubagentSessionPopover)).toHaveLength(2);
    expect(wrapper.text()).toContain("Model calls: $0.03");
    expect(wrapper.findAll(".codemode-display__call")).toHaveLength(2);
    expect(wrapper.get(".codemode-display__preview").text()).toContain("child progress");
  });

  it("overlays native output only on an exact unique canonical identity", async () => {
    const wrapper = display([{ ...call, id: "parent/1", cost: 0.02 }]);
    await wrapper.setProps({
      details: {
        calls: [{ ...call, id: "parent/1", cost: 0.02 }],
        nestedCalls: {
          complete: true,
          calls: [{ id: "parent/1", name: "subagent", status: "ok", output: "child result" }],
        },
      },
    });
    expect(wrapper.findAll(".codemode-display__call")).toHaveLength(1);
    expect(wrapper.find(".codemode-display__preview").exists()).toBe(false);
    expect(wrapper.text()).toContain("child result");
    expect(wrapper.text()).toContain("$0.02");
    expect(wrapper.getComponent(SubagentSessionPopover).props()).toMatchObject(subagent);
  });
});

describe("native nested codemode progress", () => {
  it("renders native unfinished output and completed status without retained calls", async () => {
    const wrapper = shallowMount(CodemodeDisplay, {
      props: {
        code: "run()",
        blocks: [],
        compact: true,
        status: "running",
        details: {
          nestedCalls: {
            complete: false,
            calls: [
              {
                id: "root/1",
                name: "bash",
                status: "unfinished",
                arguments: { command: "build" },
                output: "building",
              },
            ],
          },
        },
      },
      global: { stubs: { CodeBlock: { props: ["code"], template: "<pre>{{ code }}</pre>" } } },
    });
    expect(wrapper.text()).toContain("bash");
    expect(wrapper.text()).toContain("building");
    expect(wrapper.find('[aria-label="running"]').exists()).toBe(true);
    await wrapper.setProps({
      status: "success",
      details: {
        nestedCalls: {
          complete: true,
          calls: [
            {
              id: "root/1",
              name: "bash",
              status: "ok",
              arguments: { command: "build" },
              output: "built",
              durationMs: 30,
            },
          ],
        },
      },
    });
    expect(wrapper.text()).toContain("built");
    expect(wrapper.text()).not.toContain("building");
    expect(wrapper.find('[aria-label="ok"]').exists()).toBe(true);
    await wrapper.setProps({ details: {} });
    expect(wrapper.text()).not.toContain("bash");
  });
});
