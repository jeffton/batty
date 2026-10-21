import { flushPromises, mount } from "@vue/test-utils";
import { reactive } from "vue";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import CronPopover from "./CronPopover.vue";
import * as api from "@/client/lib/api";
import type { CronJob, CronRunLog } from "@/shared/types";

vi.mock("@/client/lib/api", () => ({
  updateCronDelivery: vi.fn(),
  listRunningSubagents: vi.fn(),
  listWorkspaceCronJobs: vi.fn(),
  listWorkspaceCronRunLogs: vi.fn(),
}));
const appStore = reactive({
  activeSession: { id: "main" },
  selectedWorkspaceId: "first",
  cronVersion: 0,
  connectionState: "online",
  workspaces: [
    { id: "first", label: "First workspace" },
    { id: "second", label: "Second workspace" },
  ],
});
vi.mock("@/client/stores/app", () => ({ useAppStore: () => appStore }));

function job(workspaceId: string): CronJob {
  return {
    title: `Job in ${workspaceId}`,
    id: workspaceId,
    workspaceId,
    prompt: `Detailed prompt in ${workspaceId}`,
    enabled: true,
    model: "provider/model",
    thinkingLevel: "medium",
    schedule: { kind: "every", every: "1h" },
    scheduleLabel: "Every 1h",
    createdAt: 0,
    updatedAt: 0,
    state: {},
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("cron popover", () => {
  it("loads logs lazily and refreshes them from events without polling", async () => {
    vi.useFakeTimers();
    const run: CronRunLog = {
      runId: "run-second",
      jobId: "second",
      workspaceId: "second",
      prompt: "Job in second",
      model: "provider/model",
      thinkingLevel: "medium",
      scheduleLabel: "Every 1h",
      startedAtMs: 2000,
      status: "running",
      sessionId: "cron-session",
    };
    vi.mocked(api.listWorkspaceCronJobs).mockImplementation(async (id) => [
      { ...job(id), ...(id === "second" ? { delivery: "direct" as const } : {}) },
    ]);
    vi.mocked(api.listWorkspaceCronRunLogs).mockImplementation(async (id) =>
      id === "second" ? [run, { ...run, runId: "no-session", sessionId: undefined }] : [],
    );
    const wrapper = mount(CronPopover, {
      props: { popoverId: "cron-test", anchorName: "--cron" },
      global: {
        stubs: {
          FullPopover: {
            name: "FullPopover",
            template: '<div><slot name="header-content" /><slot /></div>',
          },
          SubagentSessionPopover: true,
        },
      },
    });
    try {
      wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
      await flushPromises();
      expect(api.listWorkspaceCronJobs).toHaveBeenCalledWith("first");
      expect(api.listWorkspaceCronJobs).toHaveBeenCalledWith("second");
      expect(api.listWorkspaceCronRunLogs).not.toHaveBeenCalled();
      expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual(["Cron", "Logs"]);
      const cronPanel = wrapper.get("#cron-test-cron-panel");
      expect(cronPanel.text()).toContain("Job in first");
      expect(cronPanel.text()).toContain("Job in second");
      expect(cronPanel.text()).toContain("Second workspace");
      expect(cronPanel.text()).not.toContain("Detailed prompt");
      const jobDetails = cronPanel.findAll(".cron-popover__run-details");
      expect(jobDetails[0]!.text()).toContain("Delivery: Via assistant");
      expect(jobDetails[1]!.text()).toContain("Delivery: Direct");
      expect(cronPanel.find("select").exists()).toBe(false);
      expect(api.updateCronDelivery).not.toHaveBeenCalled();
      expect(api.listRunningSubagents).not.toHaveBeenCalled();
      const jobsRequests = vi.mocked(api.listWorkspaceCronJobs).mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      await flushPromises();
      expect(api.listWorkspaceCronJobs).toHaveBeenCalledTimes(jobsRequests);
      appStore.cronVersion++;
      await flushPromises();
      expect(api.listWorkspaceCronJobs).toHaveBeenCalledTimes(jobsRequests + 2);
      await wrapper.get("#cron-test-cron-tab").trigger("keydown", { key: "ArrowRight" });
      await flushPromises();
      expect(api.listWorkspaceCronRunLogs).toHaveBeenCalledWith("second");
      expect(wrapper.get("#cron-test-logs-tab").attributes("aria-selected")).toBe("true");
      expect(wrapper.get("#cron-test-logs-panel").text()).toContain("Running");
      const rows = wrapper.get("#cron-test-logs-panel").findAll(".cron-popover__run");
      expect(rows[0]!.element.tagName).toBe("BUTTON");
      expect(rows[0]!.attributes("popovertarget")).toBe("cron-test-cron-run-second");
      expect(rows[0]!.text()).toContain("Job in second");
      expect(rows[1]!.element.tagName).toBe("ARTICLE");
      expect(rows[1]!.attributes("popovertarget")).toBeUndefined();
      expect(
        wrapper
          .findAllComponents({ name: "SubagentSessionPopover" })
          .map((popover) => popover.props("sessionId")),
      ).toEqual(["cron-session"]);
      const details = wrapper.getComponent({ name: "SubagentSessionPopover" });
      expect(details.props("cronRun")).toEqual(run);
      const logsRequests = vi.mocked(api.listWorkspaceCronRunLogs).mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      await flushPromises();
      expect(api.listWorkspaceCronRunLogs).toHaveBeenCalledTimes(logsRequests);
      vi.mocked(api.listWorkspaceCronRunLogs).mockImplementation(async (id) =>
        id === "second" ? [{ ...run, status: "error" }] : [],
      );
      appStore.cronVersion++;
      await flushPromises();
      expect(api.listWorkspaceCronRunLogs).toHaveBeenCalledTimes(logsRequests + 2);
      expect(details.props("cronRun").status).toBe("error");
      wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "closed" });
      appStore.cronVersion++;
      await flushPromises();
      expect(api.listWorkspaceCronRunLogs).toHaveBeenCalledTimes(logsRequests + 2);
      wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
      await flushPromises();
      expect(api.listWorkspaceCronRunLogs).toHaveBeenCalledTimes(logsRequests + 4);
    } finally {
      wrapper.unmount();
    }
  });
});
