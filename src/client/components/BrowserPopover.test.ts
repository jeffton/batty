import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import BrowserPopover from "./BrowserPopover.vue";

const state = {
  pageId: "page-1",
  revision: "painted-revision",
  url: "https://example.org",
  title: "Example",
  width: 1280,
  height: 800,
  pages: [],
};
class FakeEvents extends EventTarget {
  static instances: FakeEvents[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    super();
    FakeEvents.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  send(type: string, data: unknown): void {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}
const fetchMock = vi.fn();
beforeEach(() => {
  FakeEvents.instances = [];
  vi.stubGlobal("EventSource", FakeEvents);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  fetchMock.mockResolvedValue({ ok: true, json: async () => state });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});
function create() {
  return mount(BrowserPopover, {
    props: { popoverId: "browser-test", browserId: "opaque/id", title: "Cloud browser" },
    global: {
      stubs: {
        FullPopover: {
          name: "FullPopover",
          template: '<div><slot name="heading" /><slot /></div>',
        },
      },
    },
  });
}
async function open(wrapper: ReturnType<typeof create>) {
  wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
  await flushPromises();
  return FakeEvents.instances.at(-1)!;
}
async function frame(
  wrapper: ReturnType<typeof create>,
  events: FakeEvents,
  revision = state.revision,
) {
  events.send("frame", { image: "ZmFrZQ==", pageId: "page-1", revision, width: 1280, height: 800 });
  await flushPromises();
  await wrapper.get("img").trigger("load");
  const image = wrapper.get("img").element;
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
    left: 20,
    top: 50,
    width: 320,
    height: 200,
  } as DOMRect);
  Object.defineProperty(image, "setPointerCapture", { configurable: true, value: vi.fn() });
}
function commands() {
  return fetchMock.mock.calls
    .filter(([, init]) => init.method === "POST")
    .map(([, init]) => JSON.parse(init.body));
}

test("streams swipe deltas before lift, coalesces in-flight moves and preserves the initial nested-scroll anchor", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    await frame(wrapper, events);
    const image = wrapper.get("img");
    let release!: (value: unknown) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await image.trigger("pointerdown", { pointerId: 2, button: 0, clientX: 100, clientY: 200 });
    await image.trigger("pointermove", { pointerId: 2, clientX: 100, clientY: 170 });
    await flushPromises();
    expect(commands()).toEqual([
      {
        action: "scroll",
        pageId: "page-1",
        revision: state.revision,
        x: 320,
        y: 600,
        deltaX: 0,
        deltaY: 120,
      },
    ]);
    await image.trigger("pointermove", { pointerId: 2, clientX: 100, clientY: 130 });
    await image.trigger("pointerup", { pointerId: 2, clientX: 100, clientY: 100 });
    expect(commands()).toHaveLength(1);
    release({ ok: true, json: async () => state });
    await flushPromises();
    expect(commands()[1]).toEqual({
      action: "scroll",
      pageId: "page-1",
      revision: state.revision,
      x: 320,
      y: 600,
      deltaX: 0,
      deltaY: 280,
    });
  } finally {
    wrapper.unmount();
  }
});

test("contextual field replaces values, accepts clearing, and never sends a draft to a different focused field", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    await frame(wrapper, events);
    const focused = { id: "field-a", value: "old", type: "text", multiline: false };
    const focusedState = { ...state, focused };
    fetchMock.mockResolvedValue({ ok: true, json: async () => focusedState });
    events.send("state", focusedState);
    await flushPromises();
    const input = wrapper.get('[aria-label="Focused browser field"]');
    const composing = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      cancelable: true,
    });
    input.element.dispatchEvent(composing);
    await flushPromises();
    expect(composing.defaultPrevented).toBe(false);
    expect(commands()).toEqual([]);
    await input.setValue("");
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(commands()[0]).toEqual({
      action: "fill-focused",
      value: "",
      focusId: "field-a",
      pageId: "page-1",
      revision: state.revision,
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: "The focused field changed." }),
    });
    const before = commands().length;
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(
      commands()
        .slice(before)
        .map((command) => command.action),
    ).toEqual(["fill-focused"]);
    await input.setValue("do not leak");
    events.send("state", { ...state, focused: { ...focused, id: "field-b", value: "second" } });
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(commands().filter((command) => command.action === "fill-focused")).toHaveLength(2);
    expect((input.element as HTMLInputElement).value).toBe("second");
  } finally {
    wrapper.unmount();
  }
});

test("bare domains receive https while explicit http is preserved", async () => {
  const wrapper = create();
  try {
    await open(wrapper);
    await wrapper.get('[aria-label="Browser address"]').setValue("example.com/path");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    await wrapper.get('[aria-label="Browser address"]').setValue("http://localhost:8080/");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(commands()).toEqual([
      { action: "navigate", url: "https://example.com/path" },
      { action: "navigate", url: "http://localhost:8080/" },
    ]);
  } finally {
    wrapper.unmount();
  }
});

test("disconnects while hidden/closed and reconnects without closing the remote browser", async () => {
  const wrapper = create();
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  try {
    expect(fetchMock).not.toHaveBeenCalled();
    const first = await open(wrapper);
    expect(first.url).toContain("/api/cloud-browser/opaque%2Fid/events");
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(first.closed).toBe(true);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    const second = FakeEvents.instances.at(-1)!;
    expect(second).not.toBe(first);
    wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "closed" });
    expect(second.closed).toBe(true);
    expect(commands()).toEqual([]);
  } finally {
    wrapper.unmount();
  }
});

test("blocks stale painted targets and accepts identical pixels with a fresh revision", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    await frame(wrapper, events);
    const image = wrapper.get("img");
    events.send("state", { ...state, revision: "next" });
    await flushPromises();
    await image.trigger("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    await image.trigger("pointerup", { pointerId: 1, clientX: 100, clientY: 100 });
    expect(commands()).toEqual([]);
    events.send("frame", {
      image: "ZmFrZQ==",
      pageId: "page-1",
      revision: "next",
      width: 1280,
      height: 800,
    });
    await flushPromises();
    await image.trigger("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    await image.trigger("pointerup", { pointerId: 1, clientX: 100, clientY: 100 });
    await flushPromises();
    expect(commands()).toEqual([
      { action: "click", pageId: "page-1", revision: "next", x: 320, y: 200 },
    ]);
    events.send("browser-error", { error: "Browser session ended" });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Browser session ended");
    expect(events.closed).toBe(true);
  } finally {
    wrapper.unmount();
  }
});
