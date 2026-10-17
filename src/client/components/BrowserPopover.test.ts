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
  mobile: false,
  deviceScaleFactor: 1,
  pages: [],
};
class FakeEvents {
  static instances: FakeEvents[] = [];
  static OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  closed = false;
  readonly url: string;
  sent: Array<Record<string, unknown>> = [];
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  private frameId = 0;
  constructor(url: string | URL) {
    this.url = String(url);
    FakeEvents.instances.push(this);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  send(type: string, data?: unknown): void {
    if (data === undefined) {
      this.sent.push(JSON.parse(type));
      return;
    }
    if (type === "frame") {
      const metadata = new TextEncoder().encode(
        JSON.stringify({ ...(data as object), frameId: ++this.frameId }),
      );
      const packet = new Uint8Array(4 + metadata.length);
      new DataView(packet.buffer).setUint32(0, metadata.length);
      packet.set(metadata, 4);
      this.onmessage?.({ data: packet.buffer });
    } else this.onmessage?.({ data: JSON.stringify({ event: type, data }) });
  }
}
const fetchMock = vi.fn();
beforeEach(() => {
  FakeEvents.instances = [];
  vi.stubGlobal("WebSocket", FakeEvents);
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 1280, height: 800, close: vi.fn() })),
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    void Promise.resolve().then(() => callback(0));
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
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
  const image = wrapper.get("canvas").element;
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

test("streams gesture deltas without HTTP round-trip gating and preserves nested anchor/totals", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    await frame(wrapper, events);
    const image = wrapper.get("canvas");
    await image.trigger("pointerdown", { pointerId: 2, button: 0, clientX: 100, clientY: 200 });
    await image.trigger("pointermove", { pointerId: 2, clientX: 100, clientY: 170 });
    await flushPromises();
    const first = events.sent.filter((command) => command.action === "scroll");
    expect(first).toEqual([
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
    await flushPromises();
    const scrolls = events.sent.filter((command) => command.action === "scroll");
    expect(scrolls.reduce((sum, command) => sum + Number(command.deltaY), 0)).toBe(400);
    expect(scrolls.every((command) => command.x === 320 && command.y === 600)).toBe(true);
    expect(commands()).toEqual([]);
    expect(events.sent).toContainEqual({ action: "ack", frameId: 1 });
    image.element.dispatchEvent(
      Object.assign(new Event("wheel"), {
        clientX: 300,
        clientY: 100,
        deltaY: 20,
        deltaX: 0,
        deltaMode: 0,
      }),
    );
    image.element.dispatchEvent(
      Object.assign(new Event("wheel"), {
        clientX: 180,
        clientY: 100,
        deltaY: 20,
        deltaX: 0,
        deltaMode: 0,
      }),
    );
    await flushPromises();
    expect(
      events.sent
        .filter((command) => command.action === "scroll")
        .slice(-2)
        .map((command) => command.x),
    ).toEqual([1120, 640]);
    await image.trigger("pointerdown", { pointerId: 3, button: 0, clientX: 100, clientY: 100 });
    await image.trigger("pointerup", { pointerId: 3, clientX: 100, clientY: 100 });
    await flushPromises();
    const fence = events.sent.find((command) => command.action === "flush")!;
    expect(fence).toBeDefined();
    expect(commands()).toEqual([]);
    events.send("scroll-drained", { requestId: fence.requestId });
    await flushPromises();
    expect(commands().map((command) => command.action)).toEqual(["click"]);
  } finally {
    wrapper.unmount();
  }
});

test("a stalled socket keeps exactly one animation-frame retry across repeated input", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    await frame(wrapper, events);
    const callbacks = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.set(++id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (key: number) => callbacks.delete(key));
    events.bufferedAmount = 20000;
    const image = wrapper.get("canvas");
    await image.trigger("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 200 });
    for (let i = 1; i <= 20; i++) {
      await image.trigger("pointermove", { pointerId: 1, clientX: 100, clientY: 200 - i * 8 });
      expect(callbacks.size).toBe(1);
    }
    let [key, callback] = callbacks.entries().next().value!;
    callbacks.delete(key);
    callback(0);
    expect(callbacks.size).toBe(1);
    events.bufferedAmount = 0;
    [key, callback] = callbacks.entries().next().value!;
    callbacks.delete(key);
    callback(0);
    expect(callbacks.size).toBe(0);
    expect(
      events.sent
        .filter((command) => command.action === "scroll")
        .reduce((sum, command) => sum + Number(command.deltaY), 0),
    ).toBe(640);
  } finally {
    wrapper.unmount();
  }
});

test("a timed-out scroll fence disconnects before a second control can bypass pending input", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    await frame(wrapper, events);
    vi.useFakeTimers();
    const image = wrapper.get("canvas");
    await image.trigger("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 200 });
    await image.trigger("pointerup", { pointerId: 1, clientX: 100, clientY: 100 });
    // HTTP back must fence even when the local animation-frame send is pending.
    await wrapper.get('[aria-label="Go back"]').trigger("click");
    await flushPromises();
    expect(events.sent.some((command) => command.action === "flush")).toBe(true);
    expect(commands()).toEqual([]);
    await vi.advanceTimersByTimeAsync(8000);
    await flushPromises();
    expect(events.closed).toBe(true);
    await wrapper.get('[aria-label="Go back"]').trigger("click");
    await flushPromises();
    expect(commands()).toEqual([]);
  } finally {
    wrapper.unmount();
    vi.useRealTimers();
  }
});

test("decodes one frame at a time, drops superseded pixels and ACKs stale frames without enabling wrong-target clicks", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    let release!: (bitmap: ImageBitmap) => void;
    vi.mocked(createImageBitmap).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    events.send("frame", { pageId: "page-1", revision: state.revision, width: 1280, height: 800 });
    await flushPromises();
    events.send("state", { ...state, revision: "next" });
    events.send("frame", { pageId: "page-1", revision: "next", width: 1280, height: 800 });
    events.send("frame", { pageId: "page-1", revision: "next", width: 1280, height: 800 });
    expect(events.sent).toEqual([{ action: "ack", frameId: 2 }]);
    release({ width: 3840, height: 2400, close: vi.fn() } as unknown as ImageBitmap);
    await flushPromises();
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    expect(events.sent).toEqual([
      { action: "ack", frameId: 2 },
      { action: "ack", frameId: 1 },
      { action: "ack", frameId: 3 },
    ]);
    expect(wrapper.get("canvas").attributes("data-revision")).toBe("next");
  } finally {
    wrapper.unmount();
  }
});

test("a late decoder failure cannot disconnect a reopened browser view", async () => {
  const wrapper = create();
  try {
    const first = await open(wrapper);
    let reject!: (error: Error) => void;
    vi.mocked(createImageBitmap).mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    first.send("frame", { pageId: "page-1", revision: state.revision, width: 1280, height: 800 });
    await flushPromises();
    const second = await open(wrapper);
    second.send("frame", { pageId: "page-1", revision: state.revision, width: 1280, height: 800 });
    reject(new Error("Old decoder cancelled"));
    await flushPromises();
    expect(second.closed).toBe(false);
    expect(wrapper.get("canvas").attributes("data-revision")).toBe(state.revision);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
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
    await input.trigger("compositionstart");
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
    expect(first.url).toContain("/api/cloud-browser/opaque%2Fid/socket");
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
    const image = wrapper.get("canvas");
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
    events.send("browser-error", {
      error: "Browser session ended",
      retryable: false,
      statusCode: 410,
    });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Browser session ended");
    expect(events.closed).toBe(true);
  } finally {
    wrapper.unmount();
  }
});

test("reconnects transient stream/network failures with backoff, but stops for expired and permanent failures", async () => {
  vi.useFakeTimers();
  const wrapper = create();
  try {
    const first = await open(wrapper);
    first.send("browser-error", { error: "Execution context was destroyed", retryable: true });
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toBe("Reconnecting…");
    expect(first.closed).toBe(true);
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(FakeEvents.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeEvents.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    const second = FakeEvents.instances.at(-1)!;
    expect(second).not.toBe(first);
    await frame(wrapper, second);
    await vi.advanceTimersByTimeAsync(20);
    await flushPromises();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    second.send("browser-error", { error: "Unsupported capture", retryable: false });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Unsupported capture");
    await vi.advanceTimersByTimeAsync(20000);
    expect(FakeEvents.instances).toHaveLength(2);
    await wrapper.get('[role="alert"] button').trigger("click");
    await flushPromises();
    const third = FakeEvents.instances.at(-1)!;
    third.onclose?.();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 410,
      json: async () => ({ error: "Browser session ended" }),
    });
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Browser session ended");
    expect(wrapper.find('[role="alert"] button').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeEvents.instances).toHaveLength(3);
  } finally {
    wrapper.unmount();
    vi.useRealTimers();
  }
});
