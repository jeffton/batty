import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useAppStore } from "@/client/stores/app";
import ModelConfigPopover from "./ModelConfigPopover.vue";
import SettingsPopover from "./SettingsPopover.vue";
import ModelConfigSelector from "./ModelConfigSelector.vue";

describe("SettingsPopover", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("passes the default model effort and supported options to the shared model config", () => {
    const store = useAppStore();
    store.models = [
      {
        id: "openai-codex/gpt-5.6-sol",
        label: "GPT-5.6 Sol · OpenAI Codex",
        provider: "openai-codex",
        reasoning: true,
        thinkingLevels: ["low", "medium", "high"],
        supportsImages: false,
      },
    ];
    store.settings = {
      ...store.settings,
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
      defaultThinkingLevel: "medium",
    };

    const wrapper = mount(SettingsPopover, {
      props: { popoverId: "settings-popover", anchorName: "--settings-anchor" },
    });
    const modelConfig = wrapper.findComponent(ModelConfigPopover);

    expect(wrapper.findComponent(ModelConfigSelector).exists()).toBe(true);
    expect(wrapper.get(".model-config-selector__effort-label").text()).toBe("medium");
    expect(modelConfig.props("currentModelId")).toBe("openai-codex/gpt-5.6-sol");
    expect(modelConfig.props("currentThinkingLevel")).toBe("medium");
    expect(modelConfig.props("thinkingOptions")).toEqual(["low", "medium", "high"]);
  });

  it("keeps the selector open when choosing effort before model", async () => {
    const store = useAppStore();
    store.models = [
      {
        id: "openai-codex/gpt-5.6-sol",
        label: "GPT-5.6 Sol · OpenAI Codex",
        provider: "openai-codex",
        reasoning: true,
        thinkingLevels: ["low", "medium", "high"],
        supportsImages: false,
      },
    ];
    store.settings = {
      ...store.settings,
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
      defaultThinkingLevel: "medium",
    };
    const setDefaultModel = vi
      .spyOn(store, "setDefaultModel")
      .mockImplementation(async (_modelId, thinkingLevel) => {
        store.settings.defaultThinkingLevel = thinkingLevel;
      });
    const wrapper = mount(SettingsPopover, {
      attachTo: document.body,
      props: { popoverId: "settings-popover", anchorName: "--settings-anchor" },
    });
    const modelConfig = wrapper.findComponent(ModelConfigPopover);
    const hidePopover = vi.fn();
    (modelConfig.element as HTMLElement).hidePopover = hidePopover;

    await modelConfig.findAll(".thinking-picker__btn")[2]!.trigger("click");
    expect(setDefaultModel).toHaveBeenCalledWith("openai-codex/gpt-5.6-sol", "high");
    expect(wrapper.get(".model-config-selector__effort-label").text()).toBe("high");
    await modelConfig.get(".mc-popover__model").trigger("click");
    expect(setDefaultModel).toHaveBeenLastCalledWith("openai-codex/gpt-5.6-sol", "high");
    expect(hidePopover).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("normalizes and saves effort when changing the default model", async () => {
    const store = useAppStore();
    store.models = [
      {
        id: "openai-codex/gpt-5.6-sol",
        label: "GPT-5.6 Sol · OpenAI Codex",
        provider: "openai-codex",
        reasoning: true,
        thinkingLevels: ["medium", "high"],
        supportsImages: false,
      },
      {
        id: "google/gemini-3-pro",
        label: "Gemini 3 Pro · Google",
        provider: "google",
        reasoning: true,
        thinkingLevels: ["low"],
        supportsImages: false,
      },
    ];
    store.settings = {
      ...store.settings,
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
      defaultThinkingLevel: "high",
    };
    const setDefaultModel = vi.spyOn(store, "setDefaultModel").mockResolvedValue();
    const wrapper = mount(SettingsPopover, {
      props: { popoverId: "settings-popover", anchorName: "--settings-anchor" },
    });

    await wrapper.findComponent(ModelConfigPopover).vm.$emit("setModel", "google/gemini-3-pro");

    expect(setDefaultModel).toHaveBeenCalledWith("google/gemini-3-pro", "low");
  });

  it("keeps the model configuration open to choose effort after an initial model selection", async () => {
    const store = useAppStore();
    store.models = [
      {
        id: "openai-codex/gpt-5.6-sol",
        label: "GPT-5.6 Sol · OpenAI Codex",
        provider: "openai-codex",
        reasoning: true,
        thinkingLevels: ["low", "medium", "high"],
        supportsImages: false,
      },
    ];
    store.settings = {
      ...store.settings,
      defaultProvider: undefined,
      defaultModel: undefined,
      defaultThinkingLevel: undefined,
    };
    const setDefaultModel = vi
      .spyOn(store, "setDefaultModel")
      .mockImplementation(async (modelId, thinkingLevel) => {
        const [defaultProvider, defaultModel] = modelId.split("/");
        store.settings = {
          ...store.settings,
          defaultProvider,
          defaultModel,
          defaultThinkingLevel: thinkingLevel,
        };
      });
    const wrapper = mount(SettingsPopover, {
      attachTo: document.body,
      props: { popoverId: "settings-popover", anchorName: "--settings-anchor" },
    });
    const modelConfig = wrapper.findComponent(ModelConfigPopover);
    const hidePopover = vi.fn();
    (modelConfig.element as HTMLElement & { hidePopover: () => void }).hidePopover = hidePopover;

    await modelConfig.vm.$emit("setModel", "openai-codex/gpt-5.6-sol");
    await wrapper.vm.$nextTick();

    expect(setDefaultModel).toHaveBeenCalledWith("openai-codex/gpt-5.6-sol", "low");
    expect(hidePopover).not.toHaveBeenCalled();
    expect(modelConfig.props("thinkingOptions")).toEqual(["low", "medium", "high"]);
    expect(modelConfig.findAll(".thinking-picker__btn")).toHaveLength(3);

    await modelConfig.findAll(".thinking-picker__btn")[2]!.trigger("click");

    expect(setDefaultModel).toHaveBeenLastCalledWith("openai-codex/gpt-5.6-sol", "high");
    expect(hidePopover).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("uses the full-popover frame with an explicit close button", async () => {
    const wrapper = mount(SettingsPopover, {
      props: {
        popoverId: "settings-popover",
        anchorName: "--settings-anchor",
      },
    });
    const hidePopover = vi.fn();
    (wrapper.element as HTMLElement & { hidePopover: () => void }).hidePopover = hidePopover;

    expect(wrapper.classes()).toContain("full-popover");
    expect(wrapper.classes()).toContain("settings-popover");
    expect(wrapper.text()).toContain("Settings");
    expect(wrapper.find(".settings-popover__body").exists()).toBe(true);

    await wrapper.get('[aria-label="Close settings"]').trigger("click");
    expect(hidePopover).toHaveBeenCalledOnce();
  });
});
