import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent } from "vue";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { useAppStore } from "@/client/stores/app";
import { openCloudBrowser } from "@/client/lib/api";
import ChatHeader from "./ChatHeader.vue";

vi.mock("@/client/lib/api", async (original) => ({
  ...(await original<typeof import("@/client/lib/api")>()),
  openCloudBrowser: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());
function fixture(available: boolean) {
  setActivePinia(createPinia());
  const store = useAppStore();
  store.settings.cloudBrowserAvailable = available;
  store.workspaces = [
    { id: "roy", label: "Roy", path: "/roy", kind: "workspace", isAssistant: true, isPinned: true },
  ];
  const show = vi.fn();
  const wrapper = mount(ChatHeader, {
    attachTo: document.body,
    global: {
      stubs: {
        SettingsPopover: true,
        ToolsPopover: true,
        CronPopover: true,
        ProviderUsageIndicator: true,
        SessionHeaderStatus: true,
        BrowserPopover: defineComponent({
          props: ["browserId"],
          mounted() {
            (this.$el as HTMLElement).showPopover = show;
          },
          template: '<div id="toolbar-browser" :data-browser-id="browserId" />',
        }),
      },
    },
  });
  return { store, wrapper, show };
}

test("unsupported hosts have no browser launcher and keep the other toolbar controls", () => {
  const { wrapper } = fixture(false);
  try {
    expect(wrapper.find('[aria-label="Open browser"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Settings"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Workspaces and tools"]').exists()).toBe(true);
  } finally {
    wrapper.unmount();
  }
});

test("launcher opens returned browser, coalesces clicks, and displays startup errors", async () => {
  const { wrapper, show, store } = fixture(true);
  try {
    let resolve!: (value: any) => void;
    vi.mocked(openCloudBrowser).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const button = wrapper.get('[aria-label="Open browser"]');
    await button.trigger("click");
    await button.trigger("click");
    expect(openCloudBrowser).toHaveBeenCalledExactlyOnceWith("roy");
    expect(button.attributes("disabled")).toBeDefined();
    resolve({ browserId: "reused" });
    await flushPromises();
    expect(wrapper.find('[data-browser-id="reused"]').exists()).toBe(true);
    expect(show).toHaveBeenCalledOnce();
    vi.mocked(openCloudBrowser).mockRejectedValueOnce(new Error("Browser unavailable"));
    await button.trigger("click");
    await flushPromises();
    expect(store.lastError).toBe("Browser unavailable");
    expect(button.attributes("disabled")).toBeUndefined();
  } finally {
    wrapper.unmount();
  }
});
