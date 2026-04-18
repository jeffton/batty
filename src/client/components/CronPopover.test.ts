import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import CronPopover from "@/client/components/CronPopover.vue";
import { useAppStore } from "@/client/stores/app";
import type { CronJob, SessionSummary } from "@/shared/types";

const { updateCronJob, listWorkspaceCronJobs } = vi.hoisted(() => ({
  updateCronJob: vi.fn(),
  listWorkspaceCronJobs: vi.fn(),
}));

vi.mock("@/client/lib/api", () => ({
  abortSession: vi.fn(),
  completeOpenAICodexProviderAuth: vi.fn(),
  createOrOpenDailySession: vi.fn(),
  createSession: vi.fn(),
  createWorkspace: vi.fn(),
  deleteCronJob: vi.fn(),
  getBootstrap: vi.fn(),
  getProviderAuthStatus: vi.fn(),
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  getVersion: vi.fn(async () => ({ buildId: "build-1" })),
  listWorkspaceCronJobs,
  listWorkspaceSessions: vi.fn(async (): Promise<SessionSummary[]> => []),
  listWorkspaces: vi.fn(async () => []),
  logout: vi.fn(),
  openSession: vi.fn(),
  sendPrompt: vi.fn(),
  setProviderApiKey: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionThinkingLevel: vi.fn(),
  setWorkspacePinned: vi.fn(),
  startOpenAICodexProviderAuth: vi.fn(),
  updateCronJob,
}));

vi.mock("@/client/lib/cache", () => ({
  readCachedBootstrap: vi.fn(),
  readCachedSession: vi.fn(async () => undefined),
  writeCachedBootstrap: vi.fn(),
  writeCachedSession: vi.fn(async () => undefined),
}));

vi.mock("@/client/lib/agent-notifications", () => ({
  primeAgentNotifications: vi.fn(async () => false),
}));

vi.mock("@/client/lib/push-notifications", () => ({
  syncPushSubscription: vi.fn(async () => undefined),
}));

const job: CronJob = {
  id: "cron-1",
  workspaceId: "batty",
  prompt: "Original prompt",
  model: "openai/gpt-5",
  thinkingLevel: "medium",
  session: { kind: "new" },
  createdAt: 1,
  updatedAt: 1,
  schedule: { kind: "every", every: "1h" },
  scheduleLabel: "Every hour",
  state: {},
};

describe("CronPopover", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    listWorkspaceCronJobs.mockResolvedValue([job]);
    updateCronJob.mockImplementation(async (_jobId: string, patch: Partial<CronJob>) => ({
      ...job,
      ...patch,
      session: patch.session ?? job.session,
      updatedAt: 2,
    }));
  });

  it("saves and leaves edit mode even when nothing changed", async () => {
    const store = useAppStore();
    store.workspaces = [
      {
        id: "batty",
        label: "batty",
        path: "/root/github/batty",
        kind: "workspace",
        isPinned: false,
      },
    ];
    store.selectedWorkspaceId = "batty";
    store.cronJobsByWorkspace = { batty: [job] };
    store.models = [
      {
        id: "openai/gpt-5",
        label: "GPT-5",
        provider: "openai",
        reasoning: true,
        supportsImages: true,
      },
    ];
    store.activeSession = {
      id: "web-1",
      sessionId: "session-1",
      workspaceId: "batty",
      cwd: "/root/github/batty",
      path: "/tmp/session-1.jsonl",
      model: "openai/gpt-5",
      modelLabel: "GPT-5",
      thinkingLevel: "medium",
      availableThinkingLevels: ["medium", "high"],
      isStreaming: false,
      pendingMessageCount: 0,
      updatedAt: 1,
      contextTokens: 0,
      contextWindow: 0,
      contextPercent: 0,
      totalMessageCount: 0,
      hasMoreMessages: false,
      messages: [],
      activeTools: [],
    };

    const wrapper = mount(CronPopover, {
      props: {
        popoverId: "cron-popover",
        anchorName: "--cron-anchor",
      },
      global: {
        stubs: {
          ThinkingLevelPicker: {
            template: '<div class="thinking-level-picker-stub" />',
          },
        },
      },
    });

    await wrapper.find(".cron-popover__icon-btn").trigger("click");

    const saveButton = wrapper.find(".cron-popover__save");
    expect((saveButton.element as HTMLButtonElement).disabled).toBe(false);

    await saveButton.trigger("click");
    await Promise.resolve();
    await Promise.resolve();

    expect(updateCronJob).toHaveBeenCalledWith("cron-1", {
      prompt: "Original prompt",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      session: { kind: "new" },
    });
    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(wrapper.text()).toContain("Original prompt");
  });
});
