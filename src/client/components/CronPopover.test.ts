import { flushPromises, mount } from "@vue/test-utils";
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
vi.mock("@/client/stores/app", () => ({
  useAppStore: () => ({
    activeSession: { id: "main" },
    selectedWorkspaceId: "first",
    workspaces: [
      { id: "first", label: "First workspace" },
      { id: "second", label: "Second workspace" },
    ],
  }),
}));

function job(workspaceId: string): CronJob {
  return {
    id: workspaceId,
    workspaceId,
    prompt: `Job in ${workspaceId}`,
    enabled: true,
    model: "provider/model",
    thinkingLevel: "medium",
    schedule: { kind: "every", every: "1h" },
    scheduleLabel: "Every 1h",
    session: { kind: "daily-detached" },
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
  it("lists jobs across workspaces and makes each session log one full-row button", async () => {
    vi.useFakeTimers();
    const run: CronRunLog = {
      runId: "run-second",
      jobId: "second",
      workspaceId: "second",
      prompt: "Job in second",
      model: "provider/model",
      thinkingLevel: "medium",
      session: { kind: "daily-detached" },
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
      expect(api.listWorkspaceCronRunLogs).toHaveBeenCalledWith("second");
      expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual(["Cron", "Logs"]);
      const cronPanel = wrapper.get("#cron-test-cron-panel");
      expect(cronPanel.text()).toContain("Job in first");
      expect(cronPanel.text()).toContain("Job in second");
      expect(cronPanel.text()).toContain("Second workspace");
      const jobDetails = cronPanel.findAll(".cron-popover__run-details");
      expect(jobDetails[0]!.text()).toContain("Delivery: Via assistant");
      expect(jobDetails[1]!.text()).toContain("Delivery: Direct");
      expect(cronPanel.find("select").exists()).toBe(false);
      expect(api.updateCronDelivery).not.toHaveBeenCalled();
      expect(api.listRunningSubagents).not.toHaveBeenCalled();
      await wrapper.get("#cron-test-cron-tab").trigger("keydown", { key: "ArrowRight" });
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
      vi.mocked(api.listWorkspaceCronRunLogs).mockImplementation(async (id) =>
        id === "second" ? [{ ...run, status: "error" }] : [],
      );
      await vi.advanceTimersByTimeAsync(3000);
      await flushPromises();
      expect(details.props("cronRun").status).toBe("error");
    } finally {
      wrapper.unmount();
    }
  });
});
