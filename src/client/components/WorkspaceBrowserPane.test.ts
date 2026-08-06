import { flushPromises, shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import WorkspaceBrowserFooter from "@/client/components/WorkspaceBrowserFooter.vue";
import WorkspaceBrowserHeader from "@/client/components/WorkspaceBrowserHeader.vue";
import WorkspaceBrowserPane from "@/client/components/WorkspaceBrowserPane.vue";
import { useAppStore } from "@/client/stores/app";
import type { SessionSummary, WorkspaceInfo } from "@/shared/types";

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

function makeWorkspace(id: string, isAssistant: boolean): WorkspaceInfo {
  return {
    id,
    label: id,
    path: `/workspaces/${id}`,
    kind: "workspace",
    isPinned: false,
    isAssistant,
  };
}

function makeSession(
  sessionId: string,
  workspaceId: string,
  dailySession?: SessionSummary["dailySession"],
): SessionSummary {
  return {
    id: sessionId,
    sessionId,
    firstMessage: `Session ${sessionId}`,
    updatedAt: 1,
    messageCount: 1,
    workspaceId,
    dailySession,
  };
}

describe("WorkspaceBrowserPane", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("only shows the session-list creation entry in the assistant workspace", async () => {
    const store = useAppStore();
    store.workspaces = [makeWorkspace("assistant", true), makeWorkspace("project", false)];
    store.selectedWorkspaceId = "project";
    store.sessionsByWorkspace = {
      project: [
        makeSession("today-placeholder", "project", {
          date: "2026-08-06",
          isToday: true,
          exists: false,
        }),
        makeSession("existing-daily", "project", {
          date: "2020-01-01",
          isToday: false,
          exists: true,
        }),
        makeSession("regular", "project"),
      ],
      assistant: [
        makeSession("assistant-today-placeholder", "assistant", {
          date: "2026-08-06",
          isToday: true,
          exists: false,
        }),
      ],
    };

    const startDailySession = vi.spyOn(store, "startDailySession").mockResolvedValue({
      workspaceId: "assistant",
      sessionId: "daily",
    } as never);
    const wrapper = shallowMount(WorkspaceBrowserPane);

    const footer = wrapper.findComponent(WorkspaceBrowserFooter);
    expect(footer.exists()).toBe(true);
    expect(footer.props("assistantWorkspaceLabel")).toBe("assistant");
    footer.vm.$emit("openTodaySession");
    await flushPromises();
    expect(startDailySession).toHaveBeenCalledWith("assistant");

    expect(wrapper.findAll(".workspace-browser-pane__item--session")).toHaveLength(2);
    expect(wrapper.text()).toContain("Session regular");
    expect(wrapper.findAll(".workspace-browser-pane__session-icon")).toHaveLength(1);
    expect(wrapper.find(".workspace-browser-pane__session-icon").attributes("title")).toBe(
      "Daily session",
    );

    wrapper.findComponent(WorkspaceBrowserHeader).vm.$emit("updateSearchQuery", "Today");
    await nextTick();
    expect(wrapper.findAll(".workspace-browser-pane__item-row--workspace")).toHaveLength(1);
    expect(wrapper.find(".workspace-browser-pane__item-row--workspace").text()).toContain(
      "assistant",
    );

    store.selectedWorkspaceId = "assistant";
    await nextTick();

    expect(wrapper.findComponent(WorkspaceBrowserFooter).exists()).toBe(true);
    expect(wrapper.findAll(".workspace-browser-pane__item--session")).toHaveLength(1);
    expect(wrapper.text()).toContain("Today");
    expect(wrapper.find(".workspace-browser-pane__session-icon").attributes("title")).toBe(
      "Start daily session",
    );
  });
});
