import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import SettingsPopover from "./SettingsPopover.vue";
import { useAppStore } from "@/client/stores/app";

beforeEach(() => setActivePinia(createPinia()));

function setup() {
  const store = useAppStore();
  store.settings.pushTitle = "Roy";
  store.settings.memoryModel = "openai-codex/gpt-6-luna";
  store.settings.memoryReasoning = "low";
  store.settings.memoryLanguage = "Danish";
  store.workspaces = [
    {
      id: "roy",
      label: "Roy",
      path: "/roy",
      kind: "workspace",
      isPinned: false,
      isAssistant: true,
    },
    {
      id: "project",
      label: "Project",
      path: "/project",
      kind: "workspace",
      isPinned: false,
      isAssistant: false,
    },
  ];
  const save = vi.spyOn(store, "setAssistantWorkspace").mockResolvedValue();
  const wrapper = mount(SettingsPopover, {
    attachTo: document.body,
    props: { popoverId: "settings-test", anchorName: "--settings-test" },
    global: {
      stubs: {
        FullPopover: { template: '<div><slot name="header-content" /><slot /></div>' },
        ModelConfigSelector: true,
        RouterLink: { template: "<a><slot /></a>" },
      },
    },
  });
  return { wrapper, store, save };
}

describe("Assistant settings", () => {
  it("groups settings in accessible tabs and preserves drafts while switching", async () => {
    const { wrapper } = setup();
    try {
      expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual([
        "Assistant",
        "Appearance",
        "Auth",
      ]);
      const assistant = wrapper.get("#settings-test-Assistant-panel");
      const appearance = wrapper.get("#settings-test-Appearance-panel");
      const auth = wrapper.get("#settings-test-Auth-panel");
      expect(assistant.isVisible()).toBe(true);
      expect(appearance.isVisible()).toBe(false);
      expect(auth.isVisible()).toBe(false);
      await assistant.get("input").setValue("Draft sender");
      await wrapper.get("#settings-test-Assistant-tab").trigger("keydown", { key: "ArrowRight" });
      expect(appearance.isVisible()).toBe(true);
      expect(document.activeElement?.id).toBe("settings-test-Appearance-tab");
      await wrapper.get("#settings-test-Appearance-tab").trigger("keydown", { key: "End" });
      expect(auth.isVisible()).toBe(true);
      expect(document.activeElement?.id).toBe("settings-test-Auth-tab");
      await wrapper.get("#settings-test-Auth-tab").trigger("keydown", { key: "ArrowRight" });
      expect(assistant.isVisible()).toBe(true);
      expect(assistant.get<HTMLInputElement>("input").element.value).toBe("Draft sender");
      await wrapper.get("#settings-test-Assistant-tab").trigger("keydown", { key: "ArrowLeft" });
      expect(auth.isVisible()).toBe(true);
      await wrapper.get("#settings-test-Auth-tab").trigger("keydown", { key: "Home" });
      expect(assistant.isVisible()).toBe(true);
      expect(wrapper.get("#settings-test-Assistant-tab").attributes("aria-controls")).toBe(
        assistant.attributes("id"),
      );
      expect(auth.attributes("aria-labelledby")).toBe("settings-test-Auth-tab");
      expect(wrapper.findAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
    } finally {
      wrapper.unmount();
    }
  });

  it("groups workspace, push identity and memory without changing stored values", async () => {
    const { wrapper, store, save } = setup();
    const section = wrapper.get('[aria-label="Assistant settings"]');
    expect(section.get("select").element.value).toBe("roy");
    expect(section.get("input").element.value).toBe("Roy");
    expect(save).not.toHaveBeenCalled();
    await section.get("select").setValue("project");
    expect(save).toHaveBeenCalledWith("project");
    expect(store.settings.memoryReasoning).toBe("low");
    wrapper.unmount();
  });

  it("saves memory language and surfaces failures without changing existing memory", async () => {
    const { wrapper, store } = setup();
    const save = vi.spyOn(store, "setMemoryLanguage").mockImplementation(async (language) => {
      store.settings.memoryLanguage = language;
    });
    const input = wrapper.get<HTMLInputElement>('form input[type="text"]');
    await input.setValue("Swedish");
    await input.element.closest("form")!.dispatchEvent(new Event("submit"));
    await flushPromises();
    expect(save).toHaveBeenCalledWith("Swedish");
    expect(input.element.value).toBe("Swedish");
    save.mockRejectedValueOnce(new Error("Save failed"));
    await input.setValue("English");
    await input.element.closest("form")!.dispatchEvent(new Event("submit"));
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("Save failed");
    expect(store.settings.memoryLanguage).toBe("Swedish");
    wrapper.unmount();
  });

  it("surfaces a failed workspace change", async () => {
    const { wrapper, save } = setup();
    save.mockRejectedValueOnce(new Error("Assistant is busy"));
    await wrapper.get("select").setValue("project");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("Assistant is busy");
    expect(wrapper.get("select").attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });
});
