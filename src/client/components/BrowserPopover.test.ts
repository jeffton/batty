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
  pages: [{ id: "page-1", title: "Example", url: "https://example.org", active: true }],
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
    global: { stubs: { FullPopover: { name: "FullPopover", template: "<div><slot /></div>" } } },
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
  revision = "painted-revision",
) {
  events.send("frame", { image: "ZmFrZQ==", pageId: "page-1", revision, width: 1280, height: 800 });
  await flushPromises();
  await wrapper.get("img").trigger("load");
}
function commands() {
  return fetchMock.mock.calls
    .filter(([, init]) => init.method === "POST")
    .map(([, init]) => JSON.parse(init.body));
}

test("maps taps and completed swipes to image coordinates using the painted revision, without a move queue", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    await frame(wrapper, events);
    const image = wrapper.get("img");
    vi.spyOn(image.element, "getBoundingClientRect").mockReturnValue({
      left: 20,
      top: 50,
      width: 320,
      height: 200,
    } as DOMRect);
    Object.defineProperty(image.element, "setPointerCapture", { value: vi.fn() });
    await image.trigger("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    await image.trigger("pointerup", { pointerId: 1, clientX: 100, clientY: 100 });
    await flushPromises();
    expect(commands()).toEqual([
      { action: "click", pageId: "page-1", revision: "painted-revision", x: 320, y: 200 },
    ]);
    await image.trigger("pointerdown", { pointerId: 2, button: 0, clientX: 100, clientY: 200 });
    await image.trigger("pointermove", { pointerId: 2, clientX: 100, clientY: 170 });
    expect(commands()).toHaveLength(1);
    await image.trigger("pointerup", { pointerId: 2, clientX: 100, clientY: 100 });
    await flushPromises();
    expect(commands()[1]).toEqual({
      action: "scroll",
      pageId: "page-1",
      revision: "painted-revision",
      x: 320,
      y: 600,
      deltaX: 0,
      deltaY: 400,
    });
    await wrapper.get('input[type="checkbox"]').setValue(true);
    await image.trigger("pointerdown", { pointerId: 3, button: 0, clientX: 100, clientY: 200 });
    await image.trigger("pointerup", { pointerId: 3, clientX: 180, clientY: 100 });
    await flushPromises();
    expect(commands()[2]).toEqual({
      action: "drag",
      pageId: "page-1",
      revision: "painted-revision",
      x: 320,
      y: 600,
      endX: 640,
      endY: 200,
    });
  } finally {
    wrapper.unmount();
  }
});

test("commits text once, preserves failed drafts, and blocks input until the new frame is painted", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    await frame(wrapper, events);
    const input = wrapper.get('input[aria-label="Text for focused browser field"]');
    await input.setValue("hello 👋");
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: "Page changed; retry" }),
    });
    await wrapper.get(".cloud-browser__input form").trigger("submit");
    await flushPromises();
    expect((input.element as HTMLInputElement).value).toBe("hello 👋");
    expect(wrapper.get('[role="alert"]').text()).toContain("Page changed; retry");
    expect(commands()[0]).toEqual({
      action: "text",
      text: "hello 👋",
      pageId: "page-1",
      revision: "painted-revision",
    });
    await wrapper.get(".cloud-browser__input form").trigger("submit");
    await flushPromises();
    expect((input.element as HTMLInputElement).value).toBe("");
    const holdLoad = (event: Event) => event.stopImmediatePropagation();
    wrapper.get("img").element.addEventListener("load", holdLoad, true);
    events.send("state", { ...state, revision: "next" });
    events.send("frame", {
      image: "bmV3",
      pageId: "page-1",
      revision: "next",
      width: 1280,
      height: 800,
    });
    await flushPromises();
    expect(
      wrapper
        .findAll("button")
        .find((button) => button.text() === "Enter")!
        .attributes("disabled"),
    ).toBeDefined();
    wrapper.get("img").element.removeEventListener("load", holdLoad, true);
    await wrapper.get("img").trigger("load");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Enter")!
      .trigger("click");
    await flushPromises();
    expect(commands().at(-1)).toEqual({
      action: "key",
      key: "Enter",
      pageId: "page-1",
      revision: "next",
    });
  } finally {
    wrapper.unmount();
  }
});

test("opens only on demand, disconnects while hidden/closed, reconnects on visibility, and never closes the remote browser", async () => {
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
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expect(FakeEvents.instances).toHaveLength(2);
    expect(commands()).toEqual([]);
  } finally {
    wrapper.unmount();
  }
});

test("accepts a new revision of identical already-painted pixels without waiting for another load", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    await frame(wrapper, events);
    events.send("state", { ...state, revision: "identical-new-revision" });
    events.send("frame", {
      image: "ZmFrZQ==",
      pageId: "page-1",
      revision: "identical-new-revision",
      width: 1280,
      height: 800,
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Enter")!
      .trigger("click");
    await flushPromises();
    expect(commands()).toEqual([
      { action: "key", key: "Enter", pageId: "page-1", revision: "identical-new-revision" },
    ]);
  } finally {
    wrapper.unmount();
  }
});

test("shows ended sessions and closes their stream", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    events.send("browser-error", { error: "Browser session ended" });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Browser session ended");
    expect(events.closed).toBe(true);
    expect(wrapper.get('[role="status"]').text()).toContain("Session unavailable");
  } finally {
    wrapper.unmount();
  }
});
