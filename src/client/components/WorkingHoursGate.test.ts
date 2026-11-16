import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, onMounted, onUnmounted, Teleport } from "vue";
import WorkingHoursGate from "./WorkingHoursGate.vue";
import type { WorkingHours } from "@/shared/working-hours";

const schedule: WorkingHours = {
  timeZone: "Europe/Stockholm",
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:00",
};
let wrapper: ReturnType<typeof mount>;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  wrapper?.unmount();
  vi.useRealTimers();
});
function gate(at: string, hours: WorkingHours | undefined = schedule) {
  vi.setSystemTime(new Date(at));
  wrapper = mount(WorkingHoursGate, {
    props: { schedule: hours },
    slots: { default: '<button id="app-button">App</button>' },
    attachTo: document.body,
  });
  return wrapper;
}
async function resume(at: string) {
  vi.setSystemTime(new Date(at));
  document.dispatchEvent(new Event("visibilitychange"));
  await nextTick();
}

test("disabled by default, starts inclusively and closes exactly on the end minute", async () => {
  gate("2026-11-16T07:59:59.900Z");
  expect(wrapper.find("#app-button").exists()).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  expect(wrapper.find("#app-button").exists()).toBe(true);
  await resume("2026-11-16T15:59:59.999Z");
  expect(wrapper.find("#app-button").exists()).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(wrapper.find("#app-button").exists()).toBe(false);
  expect(document.activeElement?.id).toBe("working-hours-title");
  await wrapper.setProps({ schedule: undefined });
  expect(wrapper.find("#app-button").exists()).toBe(true);
});

test("override survives hour changes, but expires at local midnight and never survives remount", async () => {
  gate("2026-11-16T18:00:00Z");
  await wrapper.get("button").trigger("click");
  expect(wrapper.find("#app-button").exists()).toBe(true);
  await resume("2026-11-16T22:59:59.999Z");
  expect(wrapper.find("#app-button").exists()).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(wrapper.find("#app-button").exists()).toBe(false);
  await wrapper.get("button").trigger("click");
  wrapper.unmount();
  gate("2026-11-16T23:00:01Z");
  expect(wrapper.find("#app-button").exists()).toBe(false);
});

test("visibility regain and pageshow recheck after sleep; overnight windows and DST use configured zone", async () => {
  gate("2026-10-24T22:30:00Z", { ...schedule, days: [6], start: "22:00", end: "03:00" });
  expect(wrapper.find("#app-button").exists()).toBe(true);
  await resume("2026-10-25T01:30:00Z");
  expect(wrapper.find("#app-button").exists()).toBe(true);
  vi.setSystemTime(new Date("2026-10-25T02:00:00Z"));
  window.dispatchEvent(new Event("pageshow"));
  await nextTick();
  expect(wrapper.find("#app-button").exists()).toBe(false);
});

test("closing removes teleports and global keyboard listeners, not merely their visual shell", async () => {
  vi.setSystemTime(new Date("2026-11-16T15:59:59Z"));
  const shortcut = vi.fn();
  const Ui = defineComponent({
    setup() {
      onMounted(() => document.addEventListener("keydown", shortcut));
      onUnmounted(() => document.removeEventListener("keydown", shortcut));
      return () => h(Teleport, { to: "body" }, [h("button", { id: "portal-action" }, "Send")]);
    },
  });
  wrapper = mount(WorkingHoursGate, { props: { schedule }, slots: { default: () => h(Ui) } });
  expect(document.querySelector("#portal-action")).not.toBeNull();
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector("#portal-action")).toBeNull();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
  expect(shortcut).not.toHaveBeenCalled();
  wrapper.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
