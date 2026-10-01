import { flushPromises, mount } from "@vue/test-utils";
import { reactive } from "vue";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import FullPopover from "@/client/components/FullPopover.vue";
import ToolsPopover from "@/client/components/ToolsPopover.vue";

const { getSessionResources } = vi.hoisted(() => ({ getSessionResources: vi.fn() }));
const store = reactive({ activeSession: { workspaceId: "batty", sessionId: "session-1" } });
vi.mock("@/client/stores/app", () => ({ useAppStore: () => store }));
vi.mock("@/client/lib/api", () => ({ getSessionResources }));
vi.mock("@/client/components/McpSettingsPanel.vue", () => ({
  default: {
    name: "McpSettingsPanel",
    props: ["active", "workspaceId"],
    template: '<div class="mcp-panel" />',
  },
}));

function mountPopover() {
  return mount(ToolsPopover, {
    props: { popoverId: "tools-popover", anchorName: "--tools", workspaceId: "batty" },
  });
}

function toggle(wrapper: ReturnType<typeof mountPopover>, newState: string) {
  wrapper.findComponent(FullPopover).vm.$emit("toggle", { newState });
}

describe("ToolsPopover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.activeSession = { workspaceId: "batty", sessionId: "session-1" };
    getSessionResources.mockResolvedValue({
      skills: [{ name: "notes", description: "Manage notes", filePath: "/skills/notes/SKILL.md" }],
      tools: [{ name: "read", description: "Read files" }],
    });
  });

  it("loads session resources on open and lists skills and tools in separate tabs", async () => {
    const wrapper = mountPopover();
    expect(getSessionResources).not.toHaveBeenCalled();
    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual([
      "MCPs",
      "Skills",
      "Tools",
    ]);
    toggle(wrapper, "open");
    await flushPromises();
    expect(getSessionResources).toHaveBeenCalledWith("session-1");
    await wrapper.get("#tools-popover-Skills-tab").trigger("click");
    const skills = wrapper.get("#tools-popover-Skills-panel");
    expect(skills.isVisible()).toBe(true);
    expect(skills.text()).toContain("notes");
    expect(skills.text()).toContain("Manage notes");
    expect(skills.text()).toContain("/skills/notes/SKILL.md");
    await wrapper.get("#tools-popover-Tools-tab").trigger("click");
    expect(wrapper.get("#tools-popover-Tools-panel").text()).toContain("Read files");
    expect(wrapper.getComponent({ name: "McpSettingsPanel" }).props("active")).toBe(true);
    expect(wrapper.get("#tools-popover-Skills-panel").attributes("style")).toContain(
      "display: none",
    );
  });

  it("supports global MCP settings without a selected workspace", async () => {
    const wrapper = mountPopover();
    await wrapper.setProps({ workspaceId: undefined });
    toggle(wrapper, "open");
    await flushPromises();
    expect(wrapper.getComponent({ name: "McpSettingsPanel" }).props()).toMatchObject({
      active: true,
      workspaceId: undefined,
    });
    expect(getSessionResources).not.toHaveBeenCalled();
    await wrapper.get("#tools-popover-Skills-tab").trigger("click");
    expect(wrapper.get("#tools-popover-Skills-panel").text()).toBe("Select a session.");
  });

  it("supports keyboard tab navigation", async () => {
    const wrapper = mountPopover();
    await wrapper.get("#tools-popover-MCPs-tab").trigger("keydown", { key: "ArrowRight" });
    expect(wrapper.get("#tools-popover-Skills-tab").attributes("aria-selected")).toBe("true");
    await wrapper.get("#tools-popover-Skills-tab").trigger("keydown", { key: "End" });
    expect(wrapper.get("#tools-popover-Tools-tab").attributes("tabindex")).toBe("0");
  });

  it("discards resources from a previous session", async () => {
    let resolve!: (value: { skills: []; tools: { name: string; description: string }[] }) => void;
    getSessionResources.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const wrapper = mountPopover();
    toggle(wrapper, "open");
    await flushPromises();
    store.activeSession = { workspaceId: "batty", sessionId: "session-2" };
    await flushPromises();
    resolve({ skills: [], tools: [{ name: "old", description: "Old tool" }] });
    await flushPromises();
    expect(wrapper.text()).not.toContain("Old tool");
    expect(getSessionResources).toHaveBeenLastCalledWith("session-2");
  });

  it("shows resource loading errors", async () => {
    getSessionResources.mockRejectedValue(new Error("Resources failed"));
    const wrapper = mountPopover();
    toggle(wrapper, "open");
    await flushPromises();
    await wrapper.get("#tools-popover-Skills-tab").trigger("click");
    expect(wrapper.get("#tools-popover-Skills-panel").text()).toBe("Resources failed");
  });
});
