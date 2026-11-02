import { afterEach, expect, it, vi } from "vite-plus/test";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import CopyStoredValue from "./CopyStoredValue.vue";
import AuthSettings from "./AuthSettings.vue";
import EnvironmentSettings from "./EnvironmentSettings.vue";
import { useAppStore } from "@/client/stores/app";
import { getSettingsCopyValue, listEnvironmentVariables } from "@/client/lib/api";

vi.mock("@/client/lib/api", async (original) => ({
  ...(await original<typeof import("@/client/lib/api")>()),
  getSettingsCopyValue: vi.fn(),
  listEnvironmentVariables: vi.fn(),
}));
vi.mock("@/client/lib/provider-auth", () => ({ watchProviderAuthAttempt: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("starts clipboard access before the network resolves and briefly confirms without rendering text or the value", async () => {
  vi.useFakeTimers();
  const saved = Promise.withResolvers<{ value: string }>();
  vi.mocked(getSettingsCopyValue).mockReturnValue(saved.promise);
  let blob: Promise<Blob> | undefined;
  vi.stubGlobal(
    "ClipboardItem",
    class {
      constructor(data: Record<string, Promise<Blob>>) {
        blob = data["text/plain"];
      }
    },
  );
  const write = vi.fn(async () => {
    await blob;
  });
  vi.stubGlobal("navigator", { clipboard: { write } });
  const wrapper = mount(CopyStoredValue, {
    props: { kind: "environment", name: "KEY", label: "KEY" },
  });
  expect(getSettingsCopyValue).not.toHaveBeenCalled();
  await wrapper.get("button").trigger("click");
  expect(write).toHaveBeenCalledOnce();
  expect(getSettingsCopyValue).toHaveBeenCalledWith("environment", "KEY");
  expect(wrapper.get("button").attributes("disabled")).toBeDefined();
  saved.resolve({ value: "test-secret" });
  await flushPromises();
  expect((await blob)!.type).toBe("text/plain");
  expect(wrapper.text()).toBe("");
  expect(wrapper.get("button").attributes("aria-label")).toBe("Copied KEY");
  expect(wrapper.find("svg.lucide-check").exists()).toBe(true);
  expect(wrapper.html()).not.toContain("test-secret");
  await vi.advanceTimersByTimeAsync(1399);
  expect(wrapper.get("button").attributes("aria-label")).toBe("Copied KEY");
  await vi.advanceTimersByTimeAsync(1);
  expect(wrapper.get("button").attributes("aria-label")).toBe("Copy KEY");
  expect(wrapper.find("svg.lucide-copy").exists()).toBe(true);
  await wrapper.get("button").trigger("click");
  await flushPromises();
  const clearTimeout = vi.spyOn(window, "clearTimeout");
  wrapper.unmount();
  expect(clearTimeout).toHaveBeenCalledExactlyOnceWith(expect.anything());
  clearTimeout.mockRestore();
});

it("reports clipboard denial without exposing its error or value", async () => {
  vi.stubGlobal("navigator", {
    clipboard: { write: vi.fn().mockRejectedValue(new Error("private detail")) },
  });
  vi.stubGlobal("ClipboardItem", class {});
  vi.mocked(getSettingsCopyValue).mockResolvedValue({ value: "test-secret" });
  const wrapper = mount(CopyStoredValue, {
    props: { kind: "provider", name: "google", label: "Gemini API key" },
  });
  await wrapper.get("button").trigger("click");
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toBe("Copy failed");
  expect(wrapper.html()).not.toContain("private detail");
  expect(wrapper.html()).not.toContain("test-secret");
  wrapper.unmount();
});

it("offers copy for saved provider keys and every environment variable but not OAuth", async () => {
  setActivePinia(createPinia());
  const store = useAppStore();
  store.providerAuth.providers = [
    { id: "google", name: "Gemini", connected: true, authKind: "apiKey" },
    { id: "openrouter", name: "OpenRouter", connected: true, authKind: "apiKey" },
    { id: "openai", name: "OpenAI", connected: true, authKind: "apiKey" },
    { id: "anthropic", name: "Anthropic", connected: true, authKind: "oauth" },
  ];
  store.settings.braveSearchConfigured = true;
  const auth = mount(AuthSettings, { props: { open: false } });
  expect(auth.findAllComponents(CopyStoredValue).map((item) => item.props("name"))).toEqual([
    "openai",
    "google",
    "openrouter",
    "",
  ]);
  vi.mocked(listEnvironmentVariables).mockResolvedValue({
    names: ["API_KEY", "ORDINARY", "EMPTY"],
  });
  const env = mount(EnvironmentSettings, { props: { open: false } });
  await env.setProps({ open: true });
  await flushPromises();
  expect(env.findAllComponents(CopyStoredValue).map((item) => item.props("name"))).toEqual([
    "API_KEY",
    "ORDINARY",
    "EMPTY",
  ]);
  expect(getSettingsCopyValue).not.toHaveBeenCalled();
  auth.unmount();
  env.unmount();
});
