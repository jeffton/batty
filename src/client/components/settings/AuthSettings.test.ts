import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import AuthSettings from "./AuthSettings.vue";
import { useAppStore } from "@/client/stores/app";

vi.mock("@/client/lib/provider-auth", () => ({ watchOpenAIAuthAttempt: vi.fn() }));

beforeEach(() => setActivePinia(createPinia()));

function setup() {
  const store = useAppStore();
  store.providerAuth = {
    providers: [
      { id: "openai", name: "OpenAI", connected: false },
      { id: "google", name: "Google", connected: false },
    ],
  };
  const wrapper = mount(AuthSettings, {
    props: { open: false },
    global: { stubs: { FullPopover: true } },
  });
  return { store, wrapper };
}

describe("Auth settings forms", () => {
  it("keeps failed API-key drafts, then saves the trimmed key and closes its editor", async () => {
    const { store, wrapper } = setup();
    const save = vi.spyOn(store, "setProviderApiKey");
    save.mockRejectedValueOnce(new Error("Key rejected")).mockResolvedValueOnce();
    try {
      await wrapper.get('[aria-label="Edit Gemini API key"]').trigger("click");
      await wrapper.get('input[placeholder="Paste Gemini API key"]').setValue("  draft-key  ");
      await wrapper.get("form").trigger("submit");
      await flushPromises();
      expect(wrapper.get('[role="alert"]').text()).toBe("Key rejected");
      expect(wrapper.get<HTMLInputElement>("input").element.value).toBe("  draft-key  ");
      await wrapper.get("form").trigger("submit");
      await flushPromises();
      expect(save).toHaveBeenLastCalledWith("google", "draft-key");
      expect(wrapper.find("input").exists()).toBe(false);
      await wrapper.get('[aria-label="Edit Gemini API key"]').trigger("click");
      expect(wrapper.get<HTMLInputElement>("input").element.value).toBe("");
    } finally {
      wrapper.unmount();
    }
  });

  it("starts subscription login and submits a callback without changing its URL", async () => {
    const { store, wrapper } = setup();
    const start = vi.spyOn(store, "startOpenAIProviderAuth").mockResolvedValue({
      attemptId: "attempt",
      providerId: "openai",
      authUrl: "https://example.test/login",
      instructions: "Finish sign-in",
      expiresAt: Date.now() + 60_000,
    });
    const complete = vi.spyOn(store, "completeOpenAIProviderAuth").mockResolvedValue();
    try {
      await wrapper.get('[aria-label="Edit ChatGPT subscription"]').trigger("click");
      await wrapper
        .findAll("button")
        .find((button) => button.text() === "Connect ChatGPT")!
        .trigger("click");
      await flushPromises();
      expect(start).toHaveBeenCalledOnce();
      expect(wrapper.get("a").attributes("href")).toBe("https://example.test/login");
      const callback = "http://127.0.0.1:1455/auth/callback?code=abc&state=def";
      await wrapper.get("textarea").setValue(` ${callback} `);
      await wrapper.get("form").trigger("submit");
      await flushPromises();
      expect(complete).toHaveBeenCalledWith("attempt", callback);
      expect(wrapper.find("textarea").exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });
});
