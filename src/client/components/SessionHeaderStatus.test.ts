import { mount } from "@vue/test-utils";
import { expect, test } from "vite-plus/test";
import SessionHeaderStatus from "./SessionHeaderStatus.vue";

test("unknown context is visibly distinct from a measured empty ring and updates after a response", async () => {
  const wrapper = mount(SessionHeaderStatus, {
    props: { connectionState: "online", contextWindow: 500_000 },
  });
  try {
    expect(wrapper.get(".session-header-status__context").attributes("title")).toBe(
      "Context usage unavailable · window 500k",
    );
    expect(wrapper.find(".session-header-status__context--unknown").exists()).toBe(true);
    expect(wrapper.find(".session-header-status__context-arc").exists()).toBe(false);
    await wrapper.setProps({ contextTokens: 152_945, contextPercent: 30.589 });
    expect(wrapper.get(".session-header-status__context").attributes("title")).toContain(
      "Last completed model request:",
    );
    expect(wrapper.get(".session-header-status__context").attributes("title")).toContain("30.6%");
    expect(wrapper.find(".session-header-status__context--unknown").exists()).toBe(false);
    expect(wrapper.get(".session-header-status__context-arc").attributes("style")).toContain("30.");
    await wrapper.setProps({ contextTokens: null, contextPercent: null });
    expect(wrapper.find(".session-header-status__context-arc").exists()).toBe(false);
    expect(wrapper.get(".session-header-status__context").attributes("title")).toContain(
      "unavailable",
    );
  } finally {
    wrapper.unmount();
  }
});
