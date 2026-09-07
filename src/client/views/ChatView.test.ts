import { shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick, reactive } from "vue";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import ChatView from "./ChatView.vue";

const { route, router } = vi.hoisted(() => ({
  route: {
    name: "workspace" as string,
    params: {} as Record<string, string>,
  },
  router: {
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
  });

  it("derives the active and interactive pane directly from the route", async () => {
    const wrapper = shallowMount(ChatView, {
      global: {
        stubs: {
          WorkspaceBrowserPane: { template: '<section data-pane="workspace" />' },
          ChatSessionPane: { template: '<section data-pane="session" />' },
        },
      },
    });

    const workspacePane = wrapper.find('[data-pane="workspace"]');
    const sessionPane = wrapper.find('[data-pane="session"]');

    expect(workspacePane.classes()).toContain("chat-shell__pane--active");
    expect(workspacePane.attributes("inert")).toBeUndefined();
    expect(workspacePane.attributes("aria-hidden")).toBe("false");
    expect(sessionPane.classes()).not.toContain("chat-shell__pane--active");
    expect(sessionPane.attributes("inert")).toBe("");
    expect(sessionPane.attributes("aria-hidden")).toBe("true");

    reactiveRoute.name = "session";
    await nextTick();

    expect(workspacePane.classes()).not.toContain("chat-shell__pane--active");
    expect(workspacePane.attributes("inert")).toBe("");
    expect(workspacePane.attributes("aria-hidden")).toBe("true");
    expect(sessionPane.classes()).toContain("chat-shell__pane--active");
    expect(sessionPane.attributes("inert")).toBeUndefined();
    expect(sessionPane.attributes("aria-hidden")).toBe("false");
  });
});
