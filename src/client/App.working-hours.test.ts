import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { flushPromises, mount } from "@vue/test-utils";
import { reactive } from "vue";
import App from "./App.vue";
import type { WorkingHours } from "@/shared/working-hours";

const mocks = vi.hoisted(() => ({ store: {} as any, replace: vi.fn() }));
vi.mock("@/client/stores/app", () => ({ useAppStore: () => mocks.store }));
vi.mock("vue-router", () => ({
  useRouter: () => ({ replace: mocks.replace, currentRoute: { value: { path: "/" } } }),
}));
let wrapper: ReturnType<typeof mount>;
let finishBootstrap: () => void;
const schedule: WorkingHours = {
  timeZone: "Europe/Stockholm",
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:00",
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T19:00:00Z"));
  const pending = new Promise<void>((resolve) => {
    finishBootstrap = resolve;
  });
  mocks.store = reactive({
    bootstrapped: true,
    authenticated: true,
    bootstrapFailed: false,
    settings: { workingHours: undefined as WorkingHours | undefined },
    bootstrap: vi.fn(() => pending),
    closeStream: vi.fn(),
    pauseReadingCache: vi.fn(),
    checkForUpdates: vi.fn(),
    recoverConnection: vi.fn(),
    persistMainCache: vi.fn(),
  });
});
afterEach(() => {
  wrapper?.unmount();
  vi.useRealTimers();
});
function app() {
  wrapper = mount(App, {
    global: { stubs: { RouterView: { template: '<button id="routed-action">Send</button>' } } },
  });
}

test("old/missing cached schedule cannot flash routed UI before fresh config arrives", async () => {
  app();
  expect(wrapper.find('[role="status"][aria-label="Booting Batty"] .spinner').exists()).toBe(true);
  expect(wrapper.find("#routed-action").exists()).toBe(false);
  mocks.store.settings.workingHours = schedule;
  finishBootstrap();
  await flushPromises();
  expect(wrapper.text()).toContain("Off the clock.");
  expect(wrapper.find("#routed-action").exists()).toBe(false);
});

test("offline cached schedule still gates after failed refresh; override makes no notification calls", async () => {
  mocks.store.settings.workingHours = schedule;
  app();
  mocks.store.bootstrapFailed = true;
  finishBootstrap();
  await flushPromises();
  expect(wrapper.text()).toContain("Off the clock.");
  await wrapper.get(".working-hours-override").trigger("click");
  expect(wrapper.find("#routed-action").exists()).toBe(true);
  // Resume/bootstrap replaces settings with a fresh JSON object. That is not a
  // reload or a new local day and must not revoke the explicit override.
  mocks.store.settings = { workingHours: { ...schedule, days: [...schedule.days].reverse() } };
  await flushPromises();
  expect(wrapper.find("#routed-action").exists()).toBe(true);
  expect(mocks.store.bootstrap).toHaveBeenCalledTimes(1);
  expect(mocks.store.recoverConnection).not.toHaveBeenCalled();
  mocks.store.settings = { workingHours: { ...schedule, end: "16:00" } };
  await flushPromises();
  expect(wrapper.text()).toContain("Off the clock.");
  expect(wrapper.find("#routed-action").exists()).toBe(false);
});

test("a schedule-free successful bootstrap preserves ordinary app access", async () => {
  app();
  finishBootstrap();
  await flushPromises();
  expect(wrapper.find("#routed-action").exists()).toBe(true);
});
