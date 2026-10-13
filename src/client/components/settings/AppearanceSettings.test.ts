import { beforeEach, expect, it, vi } from "vite-plus/test";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import AppearanceSettings from "./AppearanceSettings.vue";
import { useAppStore } from "@/client/stores/app";

beforeEach(() => setActivePinia(createPinia()));

it("saves colors independently of the title draft and restores selection on a failed save", async () => {
  const store = useAppStore();
  store.settings.appearance = { title: "Batty", color: "neutral" };
  const save = vi.spyOn(store, "setAppearance").mockImplementation(async (appearance) => {
    store.settings.appearance = appearance;
  });
  const wrapper = mount(AppearanceSettings, { props: { open: true } });
  try {
    await wrapper.get('input[type="text"]').setValue("Draft title");
    await wrapper.get('input[value="blue"]').setValue(true);
    await flushPromises();
    expect(save).toHaveBeenLastCalledWith({ title: "Batty", color: "blue" });
    expect(wrapper.get<HTMLInputElement>('input[type="text"]').element.value).toBe("Draft title");
    save.mockRejectedValueOnce(new Error("Color save failed"));
    await wrapper.get('input[value="rose"]').setValue(true);
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("Color save failed");
    expect(wrapper.get<HTMLInputElement>('input[value="blue"]').element.checked).toBe(true);
    expect(wrapper.get<HTMLInputElement>('input[value="rose"]').element.checked).toBe(false);
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(save).toHaveBeenLastCalledWith({ title: "Draft title", color: "blue" });
  } finally {
    wrapper.unmount();
  }
});
