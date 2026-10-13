import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import ToolsPopover from "./ToolsPopover.vue";
import { useAppStore } from "@/client/stores/app";
import { getSessionResources } from "@/client/lib/api";

vi.mock("@/client/lib/api", () => ({ getSessionResources: vi.fn() }));

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

function setup() {
  const store = useAppStore();
  store.workspaces = [
    {
      id: "project",
      label: "Project",
      path: "/work/project",
      kind: "workspace",
      isPinned: false,
      isAssistant: false,
    },
  ];
  const wrapper = mount(ToolsPopover, {
    attachTo: document.body,
    props: { popoverId: "tools-test", anchorName: "--tools-test" },
    global: {
      stubs: {
        FullPopover: {
          name: "FullPopover",
          template: '<div><slot name="header-content" /><slot /></div>',
        },
        McpSettingsPanel: true,
      },
    },
  });
  return { store, wrapper };
}

describe("Workspaces and tools", () => {
  it("keeps workspace details and MCP settings together with keyboard-accessible resource tabs", async () => {
    const { store, wrapper } = setup();
    store.activeSession = { id: "main" } as NonNullable<typeof store.activeSession>;
    vi.mocked(getSessionResources).mockResolvedValue({
      skills: [{ name: "Notes", description: "Local notes", filePath: "/skills/notes.md" }],
      tools: [{ name: "read", description: "Read files" }],
    });
    try {
      wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
      await flushPromises();
      expect(getSessionResources).toHaveBeenCalledWith("main");
      const workspacePanel = wrapper.get("#tools-test-Workspaces-panel");
      expect(workspacePanel.isVisible()).toBe(true);
      expect(workspacePanel.text()).toContain("Project");
      expect(workspacePanel.text()).toContain("/work/project");
      await wrapper.get("#tools-test-Workspaces-tab").trigger("keydown", { key: "ArrowRight" });
      expect(wrapper.get("#tools-test-Skills-panel").isVisible()).toBe(true);
      expect(document.activeElement?.id).toBe("tools-test-Skills-tab");
      expect(wrapper.get("#tools-test-Skills-panel").text()).toContain("Local notes");
      await wrapper.get("#tools-test-Skills-tab").trigger("keydown", { key: "ArrowRight" });
      expect(wrapper.get("#tools-test-MCPs-panel").isVisible()).toBe(true);
      expect(wrapper.getComponent({ name: "McpSettingsPanel" }).props("active")).toBe(true);
      await wrapper.get("#tools-test-MCPs-tab").trigger("keydown", { key: "ArrowRight" });
      expect(wrapper.get("#tools-test-Tools-panel").text()).toContain("Read files");
      await wrapper.get("#tools-test-Tools-tab").trigger("keydown", { key: "ArrowRight" });
      expect(wrapper.get("#tools-test-Workspaces-tab").attributes("aria-selected")).toBe("true");
      store.workspaces = [];
      await flushPromises();
      expect(workspacePanel.text()).toContain("No workspaces configured.");
      wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "closed" });
      await flushPromises();
      expect(wrapper.getComponent({ name: "McpSettingsPanel" }).props("active")).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });
});
