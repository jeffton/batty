import { flushPromises, shallowMount } from "@vue/test-utils";
import { afterEach, expect, test, vi } from "vite-plus/test";
import SharedSitesList from "./SharedSitesList.vue";
import { getSite, openSite, setSitePublic } from "@/client/lib/api";
import type { SiteDescriptor } from "@/shared/types";

vi.mock("@/client/lib/api", () => ({
  getSite: vi.fn(),
  openSite: vi.fn(),
  setSitePublic: vi.fn(),
}));

const site: SiteDescriptor = {
  kind: "site",
  id: "00000000-0000-0000-0000-000000000001",
  name: "Gallery",
  url: "/sites/00000000-0000-0000-0000-000000000001/",
  public: false,
};

function opened(site: SiteDescriptor) {
  return { site, sites: [site], recentSiteIds: [site.id] };
}

function mountSites(stored: SiteDescriptor, idPrefix = "") {
  vi.mocked(openSite).mockResolvedValue(opened(stored));
  return shallowMount(SharedSitesList, {
    props: { sites: [stored], idPrefix },
    global: {
      stubs: {
        SitePopover: false,
        FullPopover: {
          name: "FullPopover",
          template: "<div><slot name='header-actions'/><slot/></div>",
        },
      },
    },
  });
}

afterEach(() => {
  vi.resetAllMocks();
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
      vi.mocked(getSite).mockResolvedValue(site);
      const wrapper = mountSites(stored);
      try {
        const url = `${prefix}/sites/${site.id}/`;
        expect(wrapper.find("iframe").exists()).toBe(false);
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

test("site visibility comes from storage and sibling cards follow confirmed writes", async () => {
  const read = Promise.withResolvers<SiteDescriptor>();
  vi.mocked(getSite).mockReturnValueOnce(read.promise);
  const wrapper = mountSites(site);
  const sibling = mountSites(site, "sibling");
  try {
    const popover = wrapper.getComponent({ name: "FullPopover" });
    const toggle = wrapper.get<HTMLInputElement>('[role="switch"]');
    popover.vm.$emit("toggle", { newState: "open" });
    await wrapper.vm.$nextTick();
    expect(toggle.element.disabled).toBe(true);
    expect(setSitePublic).not.toHaveBeenCalled();

    read.resolve({ ...site, public: true });
    await flushPromises();
    expect(toggle.element.checked).toBe(true);
    expect(sibling.text()).toContain("Public site");

    const save = Promise.withResolvers<SiteDescriptor>();
    vi.mocked(setSitePublic).mockReturnValueOnce(save.promise);
    await toggle.setValue(false);
    expect(setSitePublic).toHaveBeenLastCalledWith(site.id, false);
    expect(toggle.element.disabled).toBe(true);
    expect(toggle.element.checked).toBe(true);
    expect(sibling.text()).toContain("Public site");

    save.reject(new Error("Write failed"));
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Write failed");
    expect(toggle.element.checked).toBe(true);
    expect(sibling.text()).toContain("Public site");

    vi.mocked(setSitePublic).mockResolvedValueOnce(site);
    await toggle.setValue(false);
    await flushPromises();
    expect(toggle.element.checked).toBe(false);
    expect(sibling.text()).toContain("Private site");

    popover.vm.$emit("toggle", { newState: "closed" });
    await wrapper.vm.$nextTick();
    vi.mocked(getSite).mockRejectedValueOnce(new Error("Read failed"));
    popover.vm.$emit("toggle", { newState: "open" });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Read failed");
    expect(toggle.element.disabled).toBe(true);
    expect(setSitePublic).toHaveBeenCalledTimes(2);
  } finally {
    wrapper.unmount();
    sibling.unmount();
  }
});

test.each([true, false])(
  "the newest overlapping visibility read wins (resolves last: %s)",
  async (newestLast) => {
    const first = Promise.withResolvers<SiteDescriptor>();
    const second = Promise.withResolvers<SiteDescriptor>();
    vi.mocked(getSite).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const chat = mountSites(site);
    const other = mountSites(site, "other");
    try {
      for (const wrapper of [chat, other]) {
        wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
        await wrapper.vm.$nextTick();
      }
      const older = () => first.resolve(site);
      const newer = () => second.resolve({ ...site, public: true });
      (newestLast ? older : newer)();
      await flushPromises();
      (newestLast ? newer : older)();
      await flushPromises();
      for (const wrapper of [chat, other]) {
        expect(wrapper.get<HTMLInputElement>('[role="switch"]').element.checked).toBe(true);
      }
    } finally {
      other.unmount();
      chat.unmount();
    }
  },
);
