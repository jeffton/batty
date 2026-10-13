import { describe, expect, it, vi } from "vite-plus/test";
import { defineComponent } from "vue";
import { mount } from "@vue/test-utils";
import TasksControl from "./TasksControl.vue";
import type { CronRunLog, RunningSubagent } from "@/shared/types";

const agent = {
  sessionId: "agent",
  prompt: "Research",
  workspaceId: "roy",
  model: "model",
  thinkingLevel: "low",
} as RunningSubagent;
const run = {
  runId: "run",
  sessionId: "cron",
  prompt: "Publish news",
  workspaceId: "roy",
  status: "running",
} as CronRunLog;

describe("compose tasks", () => {
  it("opens the selected session from the row content and retains it after the task completes", async () => {
    const hidePopover = vi.fn();
    const showPopover = vi.fn();
    const wrapper = mount(TasksControl, {
      attachTo: document.body,
      props: { subagents: [agent], cronRuns: [] },
      global: {
        stubs: {
          BasePopover: defineComponent({
            setup(_, { expose }) {
              expose({ hidePopover });
            },
            template: "<div><slot /></div>",
          }),
          SubagentSessionPopover: {
            props: ["popoverId", "sessionId"],
            template: '<div :id="popoverId" />',
          },
        },
      },
    });
    try {
      const row = wrapper.get(".tasks-popover__task");
      const target = document.getElementById(row.attributes("popovertarget")!)!;
      Object.assign(target, { showPopover });
      await row.get("strong").trigger("click");
      expect(hidePopover).toHaveBeenCalledOnce();
      expect(showPopover).toHaveBeenCalledOnce();
      await wrapper.setProps({ subagents: [] });
      expect(document.getElementById(target.id)).toBe(target);
    } finally {
      wrapper.unmount();
    }
  });

  it("combines memory, running cron and subagents without completed or duplicate sessions", async () => {
    const wrapper = mount(TasksControl, {
      props: {
        memoryPending: 3,
        subagents: [agent, { ...agent, sessionId: "cron" }],
        cronRuns: [run, { ...run, runId: "done", status: "success" }],
      },
      global: {
        stubs: { BasePopover: { template: "<div><slot /></div>" }, SubagentSessionPopover: true },
      },
    });
    try {
      expect(wrapper.get(".tasks-control").text()).toBe("3 tasks");
      const rows = wrapper.findAll(".tasks-popover__task");
      expect(rows.map((row) => row.get("strong").text())).toEqual([
        "Preparing memory",
        "Publish news",
        "Research",
      ]);
      expect(wrapper.get(".tasks-popover__header").text()).toBe("Running tasks");
      expect(rows[0]!.element.tagName).toBe("ARTICLE");
      expect(rows[0]!.attributes("popovertarget")).toBeUndefined();
      expect(rows[1]!.element.tagName).toBe("BUTTON");
      expect(rows[1]!.attributes("popovertarget")).toContain("cron-run");
      expect(rows[2]!.element.tagName).toBe("BUTTON");
      expect(rows[2]!.attributes("popovertarget")).toContain("agent-agent");
      expect(rows[2]!.attributes("aria-label")).toBe("Open task session: Research");
      expect(rows[2]!.find("button").exists()).toBe(false);
      expect(rows[2]!.get("svg").attributes("aria-hidden")).toBe("true");
      await wrapper.setProps({
        memoryPending: 0,
        subagents: [],
        cronRuns: [{ ...run, status: "success" }],
      });
      expect(wrapper.find(".tasks-control").exists()).toBe(false);
      expect(wrapper.text()).toContain("No running tasks.");
    } finally {
      wrapper.unmount();
    }
  });
});
