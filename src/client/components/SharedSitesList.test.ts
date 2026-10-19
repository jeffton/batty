import { shallowMount } from "@vue/test-utils";
import { afterEach, expect, test, vi } from "vite-plus/test";
import SharedSitesList from "./SharedSitesList.vue";
import type { SiteDescriptor } from "@/shared/types";

const site: SiteDescriptor = {
  kind: "site",
  id: "00000000-0000-0000-0000-000000000001",
  name: "Gallery",
  url: "/sites/00000000-0000-0000-0000-000000000001/",
  public: false,
};

afterEach(() => {
  delete window.__BATTY_BASE_URL__;
  vi.unstubAllGlobals();
});

test.each(["/", "/batty", "/nested/app"])(
  "stored site previews and copied links use the current base %s",
  async (baseUrl) => {
    window.__BATTY_BASE_URL__ = baseUrl;
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const prefix = baseUrl === "/" ? "" : baseUrl;
    for (const storedBase of ["", "/old-installation"]) {
      const stored = { ...site, url: `${storedBase}/sites/${site.id}/` };
      const before = JSON.stringify(stored);
      const wrapper = shallowMount(SharedSitesList, {
        props: { sites: [stored] },
        global: {
          stubs: {
            FullPopover: {
              name: "FullPopover",
              template: "<div><slot name='header-actions'/><slot/></div>",
            },
          },
        },
      });
      try {
        const url = `${prefix}/sites/${site.id}/`;
        expect(wrapper.get("iframe").attributes("src")).toBe(url);
        const popover = wrapper.getComponent({ name: "FullPopover" });
        expect(popover.attributes("subtitle")).toBe(new URL(url, window.location.href).href);
        popover.vm.$emit("toggle", { newState: "open" });
        await wrapper.vm.$nextTick();
        expect(wrapper.get("iframe").attributes("src")).toBe(`${url}?batty_preview=1`);
        await wrapper.get('[aria-label="Copy site URL"]').trigger("click");
        expect(writeText).toHaveBeenLastCalledWith(new URL(url, window.location.href).href);
        expect(JSON.stringify(stored)).toBe(before);
      } finally {
        wrapper.unmount();
      }
    }
  },
);
