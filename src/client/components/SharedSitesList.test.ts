import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import FullPopover from "./FullPopover.vue";
import SharedSitesList from "./SharedSitesList.vue";

const { setSitePublic } = vi.hoisted(() => ({ setSitePublic: vi.fn() }));
vi.mock("@/client/lib/api", () => ({ setSitePublic }));

beforeEach(() => {
  setSitePublic.mockReset();
  setSitePublic.mockResolvedValue({
    id: "site-1",
    name: "Dashboard",
    url: "/sites/site-1/",
    public: true,
  });
});

describe("SharedSitesList", () => {
  it("renders a full site preview with copy and public controls", async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const wrapper = mount(SharedSitesList, {
      props: {
        sites: [
          {
            id: "site-1",
            name: "Dashboard",
            url: "/sites/site-1/",
            public: false,
          },
        ],
      },
    });

    expect(wrapper.get("button[popovertarget='site-preview-site-1']").text()).toContain(
      "Open site",
    );
    expect(wrapper.find(".shared-sites__switch-track").exists()).toBe(true);
    expect(wrapper.get("iframe").attributes()).toMatchObject({
      src: "/sites/site-1/",
      sandbox: "allow-downloads allow-forms allow-modals allow-popups allow-scripts",
    });

    await wrapper.get("button[aria-label='Copy site URL']").trigger("click");
    expect(writeText).toHaveBeenCalledWith("http://localhost:3000/sites/site-1/");

    wrapper.findComponent(FullPopover).vm.$emit("toggle", { newState: "open" });
    await wrapper.vm.$nextTick();
    expect(wrapper.get("iframe").attributes("src")).toBe("/sites/site-1/?batty_preview=1");
    wrapper.findComponent(FullPopover).vm.$emit("toggle", { newState: "open" });
    await wrapper.vm.$nextTick();
    expect(wrapper.get("iframe").attributes("src")).toBe("/sites/site-1/?batty_preview=2");

    await wrapper.get("input[role='switch']").setValue(true);
    expect(setSitePublic).toHaveBeenCalledWith("site-1", true);
  });
});
