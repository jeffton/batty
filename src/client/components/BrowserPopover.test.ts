import {
  commands,
  create,
  FakeDecoder,
  FakeEvents,
  frame,
  open,
  rpcCall,
  state,
} from "./browser-popover-test-fixture";
import { expect, test, vi } from "vite-plus/test";
import { flushPromises } from "@vue/test-utils";
import { RpcError } from "@/shared/rpc";

test.each([
  [2400, 1600, 1365, 910],
  [1600, 2400, 910, 1365],
  [390, 844, 390, 844],
  [844, 390, 844, 390],
])(
  "fits the viewer %ix%i to a proportional %ix%i viewport",
  async (width, height, fittedWidth, fittedHeight) => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const wrapper = create();
    vi.spyOn(
      wrapper.get(".cloud-browser__viewport").element,
      "getBoundingClientRect",
    ).mockReturnValue({ width, height } as DOMRect);
    try {
      await open(wrapper);
      expect(commands()).toContainEqual({
        action: "viewport",
        width: fittedWidth,
        height: fittedHeight,
        mobile: false,
        deviceScaleFactor: window.devicePixelRatio,
      });
    } finally {
      wrapper.unmount();
    }
  },
);

test("tab and navigation state never displays pixels from the previous view", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    await frame(wrapper, events);
    expect(wrapper.get("canvas").isVisible()).toBe(true);
    for (const next of [
      { ...state, pageId: "page-2", revision: "other-tab", url: "https://other.example" },
      { ...state, pageId: "page-2", revision: "navigated", url: "https://other.example/next" },
    ]) {
      events.send("state", next);
      await flushPromises();
      expect((wrapper.get('input[placeholder="Address"]').element as HTMLInputElement).value).toBe(
        next.url,
      );
      expect((wrapper.get("canvas").element as HTMLCanvasElement).style.display).toBe("none");
      expect(wrapper.find('[role="status"]').exists()).toBe(true);
      events.send("frame", {
        pageId: next.pageId,
        revision: next.revision,
        width: 1280,
        height: 800,
      });
      await flushPromises();
      expect(wrapper.get("canvas").isVisible()).toBe(true);
      expect(wrapper.get("canvas").attributes("data-revision")).toBe(next.revision);
    }
  } finally {
    wrapper.unmount();
  }
});

test("a new view discards the old decoder and ACKs its frames without painting stale pixels", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    FakeDecoder.holdNext = true;
    events.send("frame", { pageId: "page-1", revision: state.revision, width: 1280, height: 800 });
    await flushPromises();
    events.send("state", { ...state, revision: "next" });
    events.send("frame", { pageId: "page-1", revision: "next", width: 1280, height: 800 });
    events.send("frame", { pageId: "page-1", revision: "next", width: 1280, height: 800 });
    FakeDecoder.instances[0]!.emit(1);
    await flushPromises();
    expect(FakeDecoder.instances).toHaveLength(2);
    expect(FakeDecoder.instances[0]!.state).toBe("closed");
    expect(events.sent).toEqual([
      { action: "ack", frameId: 1 },
      { action: "ack", frameId: 2 },
      { action: "ack", frameId: 3 },
    ]);
    expect(wrapper.get("canvas").attributes("data-revision")).toBe("next");
  } finally {
    wrapper.unmount();
  }
});

test("a delayed control response cannot roll back streamed navigation or block its painted input", async () => {
  const wrapper = create();
  let finish!: (value?: unknown, error?: Error) => void;
  try {
    const events = await open(wrapper);
    await frame(wrapper, events);
    rpcCall.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await wrapper.get('[aria-label="Reload page"]').trigger("click");
    await flushPromises();
    const redirected = { ...state, revision: "redirected", url: "https://example.org/redirected" };
    events.send("state", redirected);
    await frame(wrapper, events, redirected.revision);
    finish({ value: state });
    await flushPromises();
    expect((wrapper.get('[aria-label="Browser address"]').element as HTMLInputElement).value).toBe(
      redirected.url,
    );
    const image = wrapper.get("canvas");
    await image.trigger("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    await image.trigger("pointerup", { pointerId: 1, clientX: 100, clientY: 100 });
    await flushPromises();
    expect(commands().at(-1)).toEqual({
      action: "click",
      pageId: state.pageId,
      revision: redirected.revision,
      x: 320,
      y: 200,
    });
  } finally {
    wrapper.unmount();
  }
});

test("a delayed control response cannot restore a field replaced by streamed focus", async () => {
  const wrapper = create();
  let finish!: (value?: unknown, error?: Error) => void;
  try {
    const events = await open(wrapper);
    await frame(wrapper, events);
    rpcCall.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await wrapper.get('[aria-label="Reload page"]').trigger("click");
    await flushPromises();
    const focused = { id: "field-new", value: "current", type: "text", multiline: false };
    events.send("state", { ...state, focused });
    await flushPromises();
    finish({
      value: { ...state, focused: { ...focused, id: "field-old", value: "old" } },
    });
    await flushPromises();
    const input = wrapper.get('[aria-label="Focused browser field"]');
    expect((input.element as HTMLInputElement).value).toBe("current");
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(commands().slice(1)).toEqual([
      {
        action: "fill-focused",
        value: "current",
        focusId: "field-new",
        pageId: state.pageId,
        revision: state.revision,
      },
      {
        action: "key",
        key: "Enter",
        focusId: "field-new",
        pageId: state.pageId,
        revision: state.revision,
      },
    ]);
  } finally {
    wrapper.unmount();
  }
});

test("a late decoder failure cannot disconnect a reopened browser view", async () => {
  const wrapper = create();
  try {
    const first = await open(wrapper);
    FakeDecoder.holdNext = true;
    first.send("frame", { pageId: "page-1", revision: state.revision, width: 1280, height: 800 });
    await flushPromises();
    const second = await open(wrapper);
    second.send("frame", { pageId: "page-1", revision: state.revision, width: 1280, height: 800 });
    FakeDecoder.instances[0]!.callbacks.error(new DOMException("Old decoder cancelled"));
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
    rpcCall.mockResolvedValue({ value: focusedState });
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
    rpcCall.mockRejectedValueOnce(new RpcError("CONFLICT", "The focused field changed."));
    const before = commands().length;
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(
      commands()
        .slice(before)
        .map((command) => command.action),
    ).toEqual(["fill-focused"]);
    vi.useFakeTimers();
    await input.setValue("do not leak");
    events.send("state", { ...state, focused: { ...focused, id: "field-b", value: "second" } });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(80);
    expect(commands().filter((command) => command.action === "fill-focused")).toHaveLength(2);
    expect((input.element as HTMLInputElement).value).toBe("second");
  } finally {
    wrapper.unmount();
    vi.useRealTimers();
  }
});

test("tab controls switch or close only the requested page and focus a new blank tab's address", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    const pages = [
      { id: "page-1", title: "Example", url: state.url, active: true },
      { id: "page-2", title: "Other tab", url: "https://other.example", active: false },
    ];
    events.send("state", { ...state, pages });
    await flushPromises();
    expect(wrapper.get('[aria-current="page"]').text()).toContain("Example");
    await wrapper.get('[aria-label="Close tab: Other tab"]').trigger("click");
    await flushPromises();
    expect(commands()).toEqual([{ action: "close-page", pageId: "page-2" }]);
    events.send("state", { ...state, pages });
    await flushPromises();
    await wrapper
      .get(".cloud-browser-tabs__row:nth-of-type(2) .cloud-browser-tabs__select")
      .trigger("click");
    await flushPromises();
    expect(commands().at(-1)).toEqual({ action: "switch", pageId: "page-2" });
    const blank = { ...state, pageId: "page-new", url: "about:blank", title: "", pages };
    rpcCall.mockResolvedValueOnce({ value: blank });
    const address = wrapper.get('[aria-label="Browser address"]').element as HTMLInputElement;
    const focus = vi.spyOn(address, "focus");
    await wrapper.get(".cloud-browser-tabs__new").trigger("click");
    await flushPromises();
    expect(commands().at(-1)).toEqual({ action: "new-page" });
    expect(address.value).toBe(state.url);
    expect(focus).not.toHaveBeenCalled();
    events.send("state", blank);
    await flushPromises();
    expect(address.value).toBe("");
    expect(focus).toHaveBeenCalledOnce();
  } finally {
    wrapper.unmount();
  }
});

test("closing the final tab surfaces server errors without implicitly switching or creating a tab", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    events.send("state", {
      ...state,
      pages: [{ id: "page-1", title: "Example", url: state.url, active: true }],
    });
    await flushPromises();
    rpcCall.mockRejectedValueOnce(
      new RpcError("CONFLICT", "The selected tab was closed. Choose a tab or open a new one."),
    );
    await wrapper.get('[aria-label="Close tab: Example"]').trigger("click");
    await flushPromises();
    expect(commands()).toEqual([{ action: "close-page", pageId: "page-1" }]);
    expect(wrapper.get('[role="alert"]').text()).toContain("The selected tab was closed.");
    expect(wrapper.find(".cloud-browser-tabs__new").exists()).toBe(true);
  } finally {
    wrapper.unmount();
  }
});

test("a selected-tab error keeps the tab menu available for switching to a surviving tab", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    const surviving = {
      id: "page-2",
      title: "Surviving tab",
      url: "https://other.example",
      active: false,
    };
    events.send("state", {
      ...state,
      pages: [{ id: "page-1", title: "Example", url: state.url, active: true }, surviving],
    });
    await flushPromises();
    rpcCall.mockRejectedValueOnce(
      new RpcError(
        "SELECTION_CHANGED",
        "The selected tab was closed. Choose a tab or open a new one.",
        { pages: [surviving] },
      ),
    );
    await wrapper.get('[aria-label="Reload page"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('[role="status"]').attributes("aria-label")).toBe("Reconnecting browser");
    expect(wrapper.get('[aria-label="Choose tab"]').attributes("disabled")).toBeUndefined();
    rpcCall.mockResolvedValueOnce({
      value: {
        ...state,
        pageId: surviving.id,
        url: surviving.url,
        pages: [{ ...surviving, active: true }],
      },
    });
    expect(wrapper.findAll(".cloud-browser-tabs__select")).toHaveLength(1);
    expect(wrapper.get('[aria-label="Reload page"]').attributes("disabled")).toBeDefined();
    await wrapper.get(".cloud-browser-tabs__select").trigger("click");
    await flushPromises();
    expect(commands().at(-1)).toEqual({ action: "switch", pageId: "page-2" });
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect((wrapper.get('[aria-label="Browser address"]').element as HTMLInputElement).value).toBe(
      surviving.url,
    );
  } finally {
    wrapper.unmount();
  }
});

test("a fresh viewer whose selected tab was closed can create a new tab without an initial page state", async () => {
  const wrapper = create();
  try {
    rpcCall.mockRejectedValueOnce(
      new RpcError(
        "SELECTION_CHANGED",
        "The selected tab was closed. Choose a tab or open a new one.",
        { pages: [] },
      ),
    );
    await open(wrapper);
    expect(wrapper.get('[aria-label="Choose tab"]').attributes("disabled")).toBeUndefined();
    rpcCall.mockResolvedValueOnce({
      value: {
        ...state,
        pageId: "new-page",
        url: "about:blank",
        title: "",
        pages: [{ id: "new-page", title: "", url: "about:blank", active: true }],
      },
    });
    await wrapper.get(".cloud-browser-tabs__new").trigger("click");
    await flushPromises();
    expect(commands()).toEqual([{ action: "new-page" }]);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect((wrapper.get('[aria-label="Browser address"]').element as HTMLInputElement).value).toBe(
      "",
    );
  } finally {
    wrapper.unmount();
  }
});

test("a stream-selected-tab error removes stale pixels and automatically reconciles without replaying controls", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    await frame(wrapper, events);
    vi.useFakeTimers();
    const surviving = {
      id: "page-2",
      title: "Surviving tab",
      url: "https://other.example",
      active: false,
    };
    events.send("browser-error", {
      error: "The selected tab was closed. Choose a tab or open a new one.",
      retryable: false,
      statusCode: 409,
      pages: [surviving],
    });
    await flushPromises();
    expect(events.closed).toBe(true);
    expect(wrapper.get("canvas").attributes("style")).toContain("display: none");
    expect(wrapper.get('[aria-label="Choose tab"]').attributes("disabled")).toBeUndefined();
    expect(FakeEvents.instances).toHaveLength(1);
    rpcCall.mockResolvedValueOnce({
      value: {
        ...state,
        pageId: surviving.id,
        url: surviving.url,
        pages: [{ ...surviving, active: true }],
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(commands()).toEqual([]);
    expect(FakeEvents.instances).toHaveLength(2);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    const next = FakeEvents.instances.at(-1)!;
    next.send("frame", { pageId: "page-2", revision: state.revision, width: 1280, height: 800 });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(20);
    await flushPromises();
    expect(wrapper.get("canvas").attributes("style") ?? "").not.toContain("display: none");
  } finally {
    wrapper.unmount();
    vi.useRealTimers();
  }
});

test("a nonretryable stopped stream still allows an explicit new tab to reconnect", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    events.send("browser-error", { error: "Capture stopped", retryable: false });
    await flushPromises();
    expect(events.closed).toBe(true);
    rpcCall.mockResolvedValueOnce({
      value: { ...state, pageId: "new", url: "about:blank" },
    });
    await wrapper.get(".cloud-browser-tabs__new").trigger("click");
    await flushPromises();
    expect(commands()).toEqual([{ action: "new-page" }]);
    expect(FakeEvents.instances).toHaveLength(2);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  } finally {
    wrapper.unmount();
  }
});

test.each([200, 409])(
  "explicit recovery supersedes an initial state request whose late response is %i",
  async (status) => {
    const wrapper = create();
    let finish!: (value?: unknown, error?: Error) => void;
    try {
      rpcCall.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = (value, error) => (error ? reject(error) : resolve(value));
          }),
      );
      await open(wrapper);
      const initialSignal = rpcCall.mock.calls[0]![2].signal as AbortSignal;
      const fresh = {
        ...state,
        pageId: "new",
        url: "about:blank",
        pages: [{ id: "new", title: "", url: "about:blank", active: true }],
      };
      rpcCall.mockResolvedValueOnce({ value: fresh });
      await wrapper.get(".cloud-browser-tabs__new").trigger("click");
      await flushPromises();
      expect(initialSignal.aborted).toBe(true);
      expect(FakeEvents.instances).toHaveLength(1);
      const socket = FakeEvents.instances[0]!;
      if (status === 200) finish({ value: state });
      else
        finish(undefined, new RpcError("SELECTION_CHANGED", "Old selection closed", { pages: [] }));
      await flushPromises();
      expect(FakeEvents.instances).toHaveLength(1);
      expect(socket.closed).toBe(false);
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
      expect(wrapper.get('[aria-current="page"] strong').text()).toBe("about:blank");
    } finally {
      wrapper.unmount();
    }
  },
);

test.each([200, 409])(
  "a stream selection loss cancels pending and queued controls before a late %i response",
  async (status) => {
    const wrapper = create();
    let finish!: (value?: unknown, error?: Error) => void;
    try {
      const socket = await open(wrapper);
      rpcCall.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = (value, error) => (error ? reject(error) : resolve(value));
          }),
      );
      await wrapper.get('[aria-label="Reload page"]').trigger("click");
      await flushPromises();
      const oldSignal = rpcCall.mock.calls.at(-1)![2].signal as AbortSignal;
      await wrapper.get('[aria-label="Go back"]').trigger("click");
      const surviving = {
        id: "page-2",
        title: "Surviving tab",
        url: "https://other.example",
        active: false,
      };
      socket.send("browser-error", {
        error: "Selected tab closed",
        retryable: false,
        statusCode: 409,
        pages: [surviving],
      });
      await flushPromises();
      expect(oldSignal.aborted).toBe(true);
      rpcCall.mockResolvedValueOnce({
        value: {
          ...state,
          pageId: surviving.id,
          url: surviving.url,
          pages: [{ ...surviving, active: true }],
        },
      });
      await wrapper.get(".cloud-browser-tabs__select").trigger("click");
      await flushPromises();
      expect(FakeEvents.instances).toHaveLength(2);
      const recovered = FakeEvents.instances[1]!;
      if (status === 200) finish({ value: state });
      else finish(undefined, new RpcError("SELECTION_CHANGED", "Old response", { pages: [] }));
      await flushPromises();
      expect(commands().map((command) => command.action)).toEqual(["reload", "switch"]);
      expect(wrapper.get('[aria-current="page"]').text()).toContain("Surviving tab");
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
      expect(recovered.closed).toBe(false);
    } finally {
      wrapper.unmount();
    }
  },
);

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
    expect(rpcCall).not.toHaveBeenCalled();
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

test.each(["reopen", "online", "pageshow"])(
  "%s requests authoritative state and ignores an older reconnect response",
  async (trigger) => {
    const wrapper = create();
    try {
      const first = await open(wrapper);
      let finish!: (value?: unknown, error?: Error) => void;
      rpcCall.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = (value, error) => (error ? reject(error) : resolve(value));
          }),
      );
      window.dispatchEvent(new Event("online"));
      await flushPromises();
      const pendingSignal = rpcCall.mock.calls.at(-1)![2].signal as AbortSignal;
      const next = { ...state, pageId: "page-2", url: "https://survivor.example" };
      rpcCall.mockResolvedValueOnce({ value: next });
      if (trigger === "reopen") {
        const popover = wrapper.getComponent({ name: "FullPopover" });
        popover.vm.$emit("toggle", { newState: "closed" });
        popover.vm.$emit("toggle", { newState: "open" });
      } else if (trigger === "online") window.dispatchEvent(new Event("online"));
      else window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
      await flushPromises();
      expect(pendingSignal.aborted).toBe(true);
      expect(first.closed).toBe(true);
      finish({ value: state });
      await flushPromises();
      expect(
        (wrapper.get('[aria-label="Browser address"]').element as HTMLInputElement).value,
      ).toBe(next.url);
      expect(FakeEvents.instances).toHaveLength(2);
      expect(FakeEvents.instances[1]!.closed).toBe(false);
      expect(commands()).toEqual([]);
    } finally {
      wrapper.unmount();
    }
  },
);

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

test("a server-side cloud deadline is shown without an automatic reconnect loop", async () => {
  vi.useFakeTimers();
  const wrapper = create();
  try {
    rpcCall.mockRejectedValueOnce(new RpcError("TIMEOUT", "Cloud browser queue timed out."));
    wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Cloud browser queue timed out.");
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(FakeEvents.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rpcCall).toHaveBeenCalledTimes(1);
    await wrapper.get('[role="alert"] button').trigger("click");
    await flushPromises();
    expect(FakeEvents.instances).toHaveLength(1);
  } finally {
    wrapper.unmount();
    vi.useRealTimers();
  }
});

test("reconnects transient stream/network failures with backoff, but stops for expired and permanent failures", async () => {
  vi.useFakeTimers();
  const wrapper = create();
  try {
    const first = await open(wrapper);
    first.send("browser-error", { error: "Execution context was destroyed", retryable: true });
    await flushPromises();
    expect(wrapper.get('[role="status"]').attributes("aria-label")).toBe("Reconnecting browser");
    expect(wrapper.find(".cloud-browser__viewport .cloud-browser__spinner").exists()).toBe(true);
    expect(first.closed).toBe(true);
    rpcCall.mockRejectedValueOnce(new RpcError("OFFLINE", "Batty socket disconnected"));
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
    rpcCall.mockRejectedValueOnce(new RpcError("GONE", "Browser session ended"));
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
