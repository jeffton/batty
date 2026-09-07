import { flushPromises, shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { clearPaneTransition, startPaneTransition } from "@/client/lib/pane-transition";
import ChatView from "./ChatView.vue";

const { route, router } = vi.hoisted(() => ({
  route: {
    name: "workspace" as string,
    params: {} as Record<string, string>,
  },
  router: {
    back: vi.fn(),
    push: vi.fn(async (_path: string) => undefined),
  },
}));

const reactiveRoute = reactive(route);

vi.mock("vue-router", () => ({
  useRoute: () => reactiveRoute,
  useRouter: () => router,
}));

let wrapper: ReturnType<typeof shallowMount> | undefined;

function mountChatView() {
  wrapper = shallowMount(ChatView, {
    global: {
      stubs: {
        WorkspaceBrowserPane: {
          name: "WorkspaceBrowserPane",
          template: '<section data-pane="workspace" />',
        },
        ChatSessionPane: {
          name: "ChatSessionPane",
          emits: ["back"],
          template: '<section data-pane="session" />',
        },
      },
    },
  });
  return wrapper;
}

describe("ChatView", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    reactiveRoute.name = "workspace";
    reactiveRoute.params = {};
    router.back.mockReset();
    router.push.mockReset();
    router.push.mockResolvedValue(undefined);
    clearPaneTransition();
    window.history.replaceState({}, "");
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
  });

  it("derives persistent pane accessibility from the route without animating history navigation", async () => {
    const wrapper = mountChatView();
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
    expect(workspacePane.classes()).not.toContain("chat-shell__pane--transitioning");
    expect(workspacePane.attributes("inert")).toBe("");
    expect(workspacePane.attributes("aria-hidden")).toBe("true");
    expect(sessionPane.classes()).toContain("chat-shell__pane--active");
    expect(sessionPane.classes()).not.toContain("chat-shell__pane--transitioning");
    expect(sessionPane.attributes("inert")).toBeUndefined();
    expect(sessionPane.attributes("aria-hidden")).toBe("false");

    reactiveRoute.name = "workspace";
    await nextTick();
    expect(workspacePane.classes()).not.toContain("chat-shell__pane--transitioning");
    expect(sessionPane.classes()).not.toContain("chat-shell__pane--transitioning");
  });

  it("animates an explicitly opened session and consumes the transition", async () => {
    const wrapper = mountChatView();
    const workspacePane = wrapper.find('[data-pane="workspace"]');
    const sessionPane = wrapper.find('[data-pane="session"]');

    startPaneTransition("session");
    reactiveRoute.name = "session";
    await nextTick();

    expect(workspacePane.classes()).toContain("chat-shell__pane--transitioning");
    expect(sessionPane.classes()).toContain("chat-shell__pane--transitioning");

    await sessionPane.trigger("transitionend", { propertyName: "transform" });
    expect(workspacePane.classes()).not.toContain("chat-shell__pane--transitioning");
    expect(sessionPane.classes()).not.toContain("chat-shell__pane--transitioning");
  });

  it("animates the header back action through history", async () => {
    const wrapper = mountChatView();
    reactiveRoute.name = "session";
    reactiveRoute.params = { workspaceId: "batty" };
    window.history.replaceState({ back: "/workspaces/batty" }, "");
    router.back.mockImplementation(() => {
      reactiveRoute.name = "workspace";
    });

    wrapper.findComponent({ name: "ChatSessionPane" }).vm.$emit("back");
    await flushPromises();

    expect(router.back).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
    expect(wrapper.find('[data-pane="workspace"]').classes()).toContain(
      "chat-shell__pane--transitioning",
    );
  });

  it("animates the header back fallback navigation", async () => {
    const wrapper = mountChatView();
    reactiveRoute.name = "session";
    reactiveRoute.params = { workspaceId: "batty" };
    window.history.replaceState({}, "");
    router.push.mockImplementation(async (path: string) => {
      expect(path).toBe("/workspaces/batty");
      reactiveRoute.name = "workspace";
    });

    wrapper.findComponent({ name: "ChatSessionPane" }).vm.$emit("back");
    await flushPromises();

    expect(router.back).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith("/workspaces/batty");
    expect(wrapper.find('[data-pane="workspace"]').classes()).toContain(
      "chat-shell__pane--transitioning",
    );
  });
});
