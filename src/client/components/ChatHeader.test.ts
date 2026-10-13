import { expect, test, vi } from "vite-plus/test";
import { mount } from "@vue/test-utils";
import ChatHeader from "./ChatHeader.vue";

vi.mock("@/client/stores/app", () => ({
  useAppStore: () => ({
    activeSession: { model: "fixture/model" },
    connectionState: "online",
  }),
}));

test("main header retains provider usage alongside session status", () => {
  const wrapper = mount(ChatHeader, {
    global: {
      stubs: {
        ProviderUsageIndicator: true,
        SettingsPopover: true,
        ToolsPopover: true,
        CronPopover: true,
      },
    },
  });
  try {
    expect(wrapper.getComponent({ name: "ProviderUsageIndicator" }).props("model")).toBe(
      "fixture/model",
    );
    expect(wrapper.find('[aria-label="Connected"]').exists()).toBe(true);
  } finally {
    wrapper.unmount();
  }
});
