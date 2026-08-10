import { shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick, reactive } from "vue";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { usePaneTransition } from "@/client/lib/pane-transition";
import ChatView from "./ChatView.vue";

const { route, router } = vi.hoisted(() => ({
  route: {
    name: "workspace" as string,
    params: {} as Record<string, string>,
  },
  router: {
    afterEach: vi.fn(),
    back: vi.fn(async () => undefined),
    push: vi.fn(async () => undefined),
  },
}));

const reactiveRoute = reactive(route);

vi.mock("vue-router", () => ({
  useRoute: () => reactiveRoute,
  useRouter: () => router,
}));

describe("ChatView", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    reactiveRoute.name = "workspace";
    reactiveRoute.params = {};
    usePaneTransition().clearPaneTransition();
  });

  it("keeps pane transition styles until the entering pane has finished", async () => {
    usePaneTransition().setPaneTransition("slide-from-right");
    const wrapper = shallowMount(ChatView, {
      global: {
        stubs: {
          WorkspaceBrowserPane: { template: '<section data-pane="workspace" />' },
          ChatSessionPane: { template: '<section data-pane="session" />' },
        },
      },
    });

    reactiveRoute.name = "session";
    await nextTick();

    const transitions = wrapper.findAllComponents({ name: "Transition" });
    expect(transitions).toHaveLength(2);
    expect(transitions[0]?.props("name")).toBe("slide-from-right");
    expect(transitions[1]?.props("name")).toBe("slide-from-right");
    expect(router.afterEach).not.toHaveBeenCalled();

    transitions[1]?.vm.$emit("after-enter");
    await nextTick();

    expect(usePaneTransition().paneTransitionName.value).toBe("");
  });
});
