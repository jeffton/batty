import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import SettingsPopover from "../SettingsPopover.vue";
import { useAppStore } from "@/client/stores/app";
import { listEnvironmentVariables } from "@/client/lib/api";

vi.mock("@/client/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/lib/api")>()),
  listEnvironmentVariables: vi.fn(),
}));

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(listEnvironmentVariables)
    .mockReset()
    .mockResolvedValue({ names: ["EXISTING"] });
});

function setup() {
  const store = useAppStore();
  store.settings.pushTitle = "Batty";
  store.settings.memoryLanguage = "English";
  store.settings.memoryModel = "openai-codex/gpt-6-luna";
  store.settings.memoryReasoning = "low";
  const refreshAuth = vi.spyOn(store, "refreshProviderAuthStatus").mockResolvedValue();
  const loadAgents = vi.spyOn(store, "getBattyAgentsFile").mockResolvedValue("Agent instructions");
  const wrapper = mount(SettingsPopover, {
    props: { popoverId: "settings-test", anchorName: "--settings-test" },
    global: {
      stubs: {
        FullPopover: {
          name: "FullPopover",
          emits: ["toggle"],
          template: '<div class="settings-popover"><slot /></div>',
        },
        ModelConfigSelector: true,
        RouterLink: { template: "<a><slot /></a>" },
      },
    },
  });
  async function toggle(newState: "open" | "closed") {
    wrapper.findComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState });
    await flushPromises();
  }
  return { wrapper, store, refreshAuth, loadAgents, toggle };
}

function section(wrapper: ReturnType<typeof setup>["wrapper"], title: string) {
  return wrapper.findAll("section").find((item) => item.text().startsWith(title))!;
}

describe("Settings popover lifecycle", () => {
  it("refreshes remote settings on opening and clears environment drafts on closing", async () => {
    const { wrapper, refreshAuth, toggle } = setup();
    expect(refreshAuth).not.toHaveBeenCalled();
    expect(listEnvironmentVariables).not.toHaveBeenCalled();
    await toggle("open");
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(listEnvironmentVariables).toHaveBeenCalledTimes(1);
    const environment = section(wrapper, "Environment variables");
    expect(environment.text()).toContain("EXISTING");
    await environment.get('[aria-label="Variable name"]').setValue("NEW_KEY");
    await environment.get('[aria-label="Variable value"]').setValue("secret draft");
    await wrapper.get('input[maxlength="40"]').setValue("Unsaved title");
    await toggle("closed");
    await toggle("open");
    expect(refreshAuth).toHaveBeenCalledTimes(2);
    expect(listEnvironmentVariables).toHaveBeenCalledTimes(2);
    expect(environment.get<HTMLInputElement>('[aria-label="Variable name"]').element.value).toBe(
      "",
    );
    expect(environment.get<HTMLInputElement>('[aria-label="Variable value"]').element.value).toBe(
      "",
    );
    expect(wrapper.get<HTMLInputElement>('input[maxlength="40"]').element.value).toBe(
      "Unsaved title",
    );
    wrapper.unmount();
  });

  it("keeps one credentials/instructions editor open and resets editors and errors on reopening", async () => {
    const { wrapper, store, loadAgents, toggle } = setup();
    vi.spyOn(store, "setBraveSearchApiKey").mockRejectedValue(new Error("Invalid search key"));
    await toggle("open");
    const agents = section(wrapper, "Batty AGENTS file");
    const auth = section(wrapper, "Auth");
    await agents.get("button").trigger("click");
    await flushPromises();
    expect(loadAgents).toHaveBeenCalledTimes(1);
    expect(agents.get<HTMLTextAreaElement>("textarea").element.value).toBe("Agent instructions");
    await auth.get("button").trigger("click");
    expect(agents.find("textarea").exists()).toBe(false);
    await auth.get("input").setValue("invalid");
    await auth.get(".settings-popover__editor button").trigger("click");
    await flushPromises();
    expect(auth.text()).toContain("Invalid search key");
    await toggle("closed");
    expect(auth.find("input").exists()).toBe(false);
    await toggle("open");
    await auth.get("button").trigger("click");
    expect(auth.text()).not.toContain("Invalid search key");
    expect(auth.get<HTMLInputElement>("input").element.value).toBe("invalid");
    await agents.get("button").trigger("click");
    await flushPromises();
    expect(auth.find("input").exists()).toBe(false);
    expect(agents.find("textarea").exists()).toBe(true);
    wrapper.unmount();
  });
});
