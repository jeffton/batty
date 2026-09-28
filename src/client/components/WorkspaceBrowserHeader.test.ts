import { shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import WorkspaceBrowserHeader from "./WorkspaceBrowserHeader.vue";

const props = {
  popoverId: "settings-popover",
  popoverAnchor: "--settings-anchor",
  connectionState: "offline" as const,
  connectionDescription: "Offline",
  searchSessionError: "Search failed",
  searchOpen: false,
  searchQuery: "",
};

describe("WorkspaceBrowserHeader", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("keeps stacked notices inside the shadowed header without a gap", () => {
    const wrapper = shallowMount(WorkspaceBrowserHeader, { props });
    const notices = wrapper.findAll(".workspace-browser-header__notice");

    expect(notices).toHaveLength(2);
    expect(notices[0]?.text()).toContain("Offline or reconnecting");
    expect(notices[1]?.text()).toBe("Search failed");
    expect(wrapper.get("header").element.contains(notices[0]!.element)).toBe(true);
    expect(notices[0]?.element.nextElementSibling).toBe(notices[1]?.element);
  });
});
