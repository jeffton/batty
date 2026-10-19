import { shallowMount } from "@vue/test-utils";
import { describe, expect, it } from "vite-plus/test";
import ToolCallBlock from "./ToolCallBlock.vue";

const actions = ["run", "await", "queue", "resume", "steer", "stop"];

function mountCall(
  action: string,
  options: {
    sessionId?: string;
    resultId?: string;
    status?: "running" | "success" | "error";
    allowSessionPopovers?: boolean;
    name?: string;
  } = {},
) {
  return shallowMount(ToolCallBlock, {
    props: {
      name: options.name ?? "subagent",
      arguments: { action, sessionId: options.sessionId },
      toolCallId: "call-123",
      status: options.status ?? "success",
      allowSessionPopovers: options.allowSessionPopovers ?? true,
      ...(options.resultId === undefined
        ? {}
        : { resultDetails: { subagent: { sessionId: options.resultId } } }),
    },
  });
}

describe("subagent tool session buttons", () => {
  it.each(actions)(
    "opens the explicit session for %s, including errors and pending calls",
    (action) => {
      for (const status of ["running", "success", "error"] as const) {
        const wrapper = mountCall(action, { sessionId: "worker-42", status });
        const button = wrapper.get(".tool-call__subagent-btn");
        const popover = wrapper.getComponent({ name: "SubagentSessionPopover" });
        expect(popover.props("sessionId")).toBe("worker-42");
        expect(button.attributes("popovertarget")).toBe(popover.props("popoverId"));
        wrapper.unmount();
      }
    },
  );

  it("shows the immediate start result without an async detail flag", async () => {
    const wrapper = mountCall("run", { resultId: "worker-42" });
    await wrapper.setProps({
      resultDetails: { subagent: { sessionId: "worker-42", respondIn: "session" } },
      resultBlocks: [{ type: "text", text: "Started. Session ID: worker-42" }],
    });
    expect(wrapper.getComponent({ name: "CodeBlock" }).props("code")).toBe(
      "Started. Session ID: worker-42",
    );
    expect(wrapper.find(".tool-call__result").exists()).toBe(true);
    wrapper.unmount();
  });

  it("uses the returned session ID instead of the requested ID", () => {
    const wrapper = mountCall("run", { sessionId: "requested", resultId: "created" });
    expect(wrapper.getComponent({ name: "SubagentSessionPopover" }).props("sessionId")).toBe(
      "created",
    );
    wrapper.unmount();
  });

  it.each(actions)(
    "does not infer a session from result text or a tool-call ID for %s",
    async (action) => {
      const wrapper = mountCall(action);
      await wrapper.setProps({ resultBlocks: [{ type: "text", text: "Session ID: 999" }] });
      expect(wrapper.find(".tool-call__subagent-btn").exists()).toBe(false);
      wrapper.unmount();
    },
  );

  it.each(["", "   "])("does not show a button for an empty ID (%j)", (id) => {
    const wrapper = mountCall("steer", { sessionId: id, resultId: id });
    expect(wrapper.find(".tool-call__subagent-btn").exists()).toBe(false);
    wrapper.unmount();
  });

  it("respects disabled session popovers and unrelated tools", () => {
    for (const options of [{ allowSessionPopovers: false }, { name: "cron" }]) {
      const wrapper = mountCall("steer", { sessionId: "worker-42", ...options });
      expect(wrapper.find(".tool-call__subagent-btn").exists()).toBe(false);
      wrapper.unmount();
    }
  });
});
