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
  it("keeps memory errors on their task until recovery, including without a backlog", async () => {
    const wrapper = mount(TasksControl, {
      props: { subagents: [agent], cronRuns: [], memoryPending: 2, memoryError: "Invalid prompt" },
      global: {
        stubs: { BasePopover: { template: "<div><slot /></div>" }, SubagentSessionPopover: true },
      },
    });
    try {
      const memory = wrapper.get("article.tasks-popover__task");
      expect(memory.get('[role="alert"]').text()).toBe("Invalid prompt");
      expect(memory.find(".spinner").exists()).toBe(false);
      expect(wrapper.get('button[aria-label="Running tasks"]').text()).toBe("2 tasks");
      await wrapper.setProps({ memoryPending: 0 });
      expect(wrapper.get("article.tasks-popover__task").text()).toContain("Invalid prompt");
      await wrapper.setProps({ memoryError: undefined });
      expect(wrapper.find("article.tasks-popover__task").exists()).toBe(false);
      expect(wrapper.get('button[aria-label="Running tasks"]').text()).toBe("1 task");
      expect(wrapper.get(".tasks-popover__task").text()).toContain("Research");
    } finally {
      wrapper.unmount();
    }
  });

  it("opens the selected session from the row content and retains it after the task completes", async () => {
    const hidePopover = vi.fn();
    const showPopover = vi.fn();
    const wrapper = mount(TasksControl, {
      attachTo: document.body,
      props: { subagents: [], cronRuns: [run] },
      global: {
        stubs: {
          BasePopover: defineComponent({
            setup(_, { expose }) {
              expose({ hidePopover });
            },
            template: "<div><slot /></div>",
          }),
          SubagentSessionPopover: {
            name: "SubagentSessionPopover",
            props: ["popoverId", "sessionId", "cronRun"],
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
      const details = wrapper.getComponent({ name: "SubagentSessionPopover" });
      expect(details.props("cronRun")).toEqual(run);
      await wrapper.setProps({ cronRuns: [] });
      expect(document.getElementById(target.id)).toBe(target);
      expect(details.props("cronRun")).toBeUndefined();
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
      expect(rows[0]!.element.tagName).toBe("ARTICLE");
      expect(rows[0]!.attributes("popovertarget")).toBeUndefined();
      expect(rows[1]!.element.tagName).toBe("BUTTON");
      expect(rows[1]!.attributes("popovertarget")).toContain("cron-run");
      expect(rows[2]!.element.tagName).toBe("BUTTON");
      expect(rows[2]!.attributes("popovertarget")).toContain("agent-agent");
      await wrapper.setProps({
        memoryPending: 0,
        subagents: [],
        cronRuns: [{ ...run, status: "success" }],
      });
      expect(wrapper.find(".tasks-control").exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });
});
