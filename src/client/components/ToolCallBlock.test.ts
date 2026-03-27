import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vite-plus/test";
import ToolCallBlock from "@/client/components/ToolCallBlock.vue";

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line-${index + 1}`).join("\n");
}

describe("ToolCallBlock", () => {
  it("shows read offset and limit inline without duplicating them in generic metadata", () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "read",
        arguments: {
          path: "src/server/main.ts",
          offset: 260,
          limit: 80,
        },
        status: "success",
      },
    });

    expect(wrapper.find(".tool-call__meta--read").text()).toContain("offset");
    expect(wrapper.find(".tool-call__meta--read").text()).toContain("limit");
    expect(wrapper.findAll(".tool-call__meta-row")).toHaveLength(0);
  });

  it("tails bash output and expands to the full output on demand", async () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "bash",
        arguments: {
          command: "pnpm test",
        },
        resultBlocks: [{ type: "text", text: lines(30) }],
        status: "success",
      },
    });

    const blocks = wrapper.findAll("pre.code-block");
    expect(blocks[0]?.text()).toContain("$ pnpm test");
    expect(blocks[1]?.text()).toContain("line-30");
    expect(blocks[1]?.text()).toContain("line-6");
    expect(blocks[1]?.text()).not.toContain("line-5");
    expect(wrapper.text()).toContain("Show full output");

    await wrapper.get(".tool-call__expand-btn").trigger("click");

    const expandedBlocks = wrapper.findAll("pre.code-block");
    expect(expandedBlocks[1]?.text()).toContain("line-1");
    expect(wrapper.text()).toContain("Collapse output");
  });

  it("tails write content and expands to the full buffer on demand", async () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "write",
        arguments: {
          path: "src/client/components/ToolCallBlock.vue",
          content: lines(30),
        },
        status: "success",
      },
    });

    expect(wrapper.find("pre.code-block").text()).toContain("line-30");
    expect(wrapper.find("pre.code-block").text()).toContain("line-6");
    expect(wrapper.find("pre.code-block").text()).not.toContain("line-5");

    await wrapper.get(".tool-call__expand-btn").trigger("click");

    expect(wrapper.find("pre.code-block").text()).toContain("line-1");
  });
});
