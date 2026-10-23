import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import AuthSettings from "./AuthSettings.vue";
import { useAppStore } from "@/client/stores/app";

vi.mock("@/client/lib/provider-auth", () => ({ watchProviderAuthAttempt: vi.fn() }));

beforeEach(() => setActivePinia(createPinia()));

function setup() {
  const store = useAppStore();
  store.providerAuth = {
    providers: [
      { id: "openai", name: "OpenAI", connected: false },
      { id: "openai-codex", name: "OpenAI Codex (legacy)", connected: false },
      { id: "anthropic", name: "Anthropic (Claude Pro/Max)", connected: false },
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
  it("groups provider families before other integrations regardless of connection status", async () => {
    const { store, wrapper } = setup();
    try {
      store.providerAuth.providers = [
        { id: "openrouter", name: "OpenRouter", connected: true },
        { id: "anthropic", name: "Anthropic", connected: true },
        { id: "openai-codex", name: "OpenAI Codex (legacy)", connected: true },
        { id: "google", name: "Google", connected: false },
        { id: "openai", name: "OpenAI", connected: false },
      ];
      await flushPromises();
      const expected = [
        "Edit ChatGPT subscription",
        "Edit OpenAI Codex (legacy)",
        "Edit Anthropic (Claude Pro/Max)",
        "Edit Gemini API key",
        "Edit OpenRouter API key",
        "Edit Brave Search API key",
      ];
      const labels = () =>
        wrapper
          .findAll('button[aria-label^="Edit "]')
          .map((button) => button.attributes("aria-label"));
      expect(labels()).toEqual(expected);
      store.providerAuth.providers[0]!.connected = false;
      store.providerAuth.providers[4]!.connected = true;
      await flushPromises();
      expect(labels()).toEqual(expected);
    } finally {
      wrapper.unmount();
    }
  });

  it.each([
    ["openai-codex", "OpenAI Codex (legacy)", "Connect Codex (legacy)"],
    ["anthropic", "Anthropic (Claude Pro/Max)", "Connect Claude"],
  ])("keeps the %s attempt in its own editor", async (providerId, title, connectLabel) => {
    const { store, wrapper } = setup();
    const start = vi.spyOn(store, "startProviderAuth").mockResolvedValue({
      attemptId: "attempt",
      providerId,
      authUrl: "https://example.test/login",
      instructions: "Copy the code",
      expiresAt: Date.now() + 60_000,
    });
    const complete = vi.spyOn(store, "completeProviderAuth").mockResolvedValue();
    try {
      await wrapper.get(`[aria-label="Edit ${title}"]`).trigger("click");
      if (providerId === "anthropic") {
        expect(wrapper.text()).toContain("Anthropic does not permit");
        expect(wrapper.get("a").attributes("href")).toContain(
          "legal-and-compliance#authentication-and-credential-use",
        );
      }
      await wrapper
        .findAll("button")
        .find((button) => button.text() === connectLabel)!
        .trigger("click");
      await flushPromises();
      expect(start).toHaveBeenCalledExactlyOnceWith(providerId);
      await wrapper.get('[aria-label="Edit ChatGPT subscription"]').trigger("click");
      expect(wrapper.find("textarea").exists()).toBe(false);
      expect(wrapper.find('a[href="https://example.test/login"]').exists()).toBe(false);
      await wrapper.get(`[aria-label="Edit ${title}"]`).trigger("click");
      await wrapper.get("textarea").setValue(" code#state ");
      await wrapper.get("form").trigger("submit");
      await flushPromises();
      expect(complete).toHaveBeenCalledWith("attempt", "code#state");
      expect(wrapper.find("textarea").exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

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
    const start = vi.spyOn(store, "startProviderAuth").mockResolvedValue({
      attemptId: "attempt",
      providerId: "openai",
      authUrl: "https://example.test/login",
      instructions: "Finish sign-in",
      expiresAt: Date.now() + 60_000,
    });
    const complete = vi.spyOn(store, "completeProviderAuth").mockResolvedValue();
    try {
      await wrapper.get('[aria-label="Edit ChatGPT subscription"]').trigger("click");
      await wrapper
        .findAll("button")
        .find((button) => button.text() === "Connect ChatGPT")!
        .trigger("click");
      await flushPromises();
      expect(start).toHaveBeenCalledExactlyOnceWith("openai");
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
