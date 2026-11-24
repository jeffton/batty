import { commands, create, frame, open, state } from "./browser-popover-test-fixture";
import { expect, test, vi } from "vite-plus/test";
import { flushPromises } from "@vue/test-utils";

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

test("native touch preserves boundaries under backpressure and never synthesizes a second mouse click", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    events.send("state", { ...state, mobile: true });
    await frame(wrapper, events);
    const image = wrapper.get("canvas");
    const callbacks = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.set(++next, callback);
      return next;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    events.bufferedAmount = 20000;
    await image.trigger("pointerdown", {
      pointerType: "touch",
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: 200,
    });
    for (let i = 1; i <= 10; i++)
      await image.trigger("pointermove", { pointerId: 1, clientX: 100, clientY: 200 - i * 5 });
    await image.trigger("pointerup", { pointerId: 1, clientX: 100, clientY: 150 });
    await image.trigger("pointerdown", {
      pointerType: "touch",
      pointerId: 2,
      button: 0,
      clientX: 100,
      clientY: 150,
    });
    await image.trigger("pointercancel");
    events.bufferedAmount = 0;
    const [id, callback] = callbacks.entries().next().value!;
    callbacks.delete(id);
    callback(0);
    const touches = events.sent.filter((command) => command.action === "touch");
    expect(touches.map((command) => command.phase)).toEqual([
      "start",
      "move",
      "end",
      "start",
      "cancel",
    ]);
    expect(touches[1]).toMatchObject({ x: 320, y: 400 });
    expect(commands()).toEqual([]);
    expect(events.sent.some((command) => command.action === "scroll")).toBe(false);
    await image.trigger("pointerdown", {
      pointerType: "touch",
      pointerId: 3,
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    await image.trigger("pointerup", { pointerId: 3, clientX: 100, clientY: 100 });
    expect(
      events.sent
        .filter((command) => command.action === "touch")
        .slice(-2)
        .map((command) => command.phase),
    ).toEqual(["start", "end"]);
    expect(commands()).toEqual([]);
  } finally {
    wrapper.unmount();
  }
});

test("native touch uses source timestamps when event handlers run late", async () => {
  const wrapper = create();
  try {
    const events = await open(wrapper);
    events.send("state", { ...state, mobile: true });
    await frame(wrapper, events);
    const image = wrapper.get("canvas").element;
    const now = vi.spyOn(performance, "now");
    const send = (type: string, timestamp: number, handledAt: number, y: number) => {
      now.mockReturnValue(handledAt);
      const event = new Event(type);
      Object.defineProperties(event, {
        timeStamp: { value: timestamp },
        pointerId: { value: 1 },
        pointerType: { value: "touch" },
        button: { value: 0 },
        clientX: { value: 100 },
        clientY: { value: y },
      });
      image.dispatchEvent(event);
    };
    send("pointerdown", 1000, 1100, 200);
    send("pointermove", 1016, 1150, 170);
    send("pointerup", 1032, 1400, 170);
    const touches = events.sent.filter((command) => command.action === "touch");
    expect(touches.map((command) => [command.phase, command.elapsedMs])).toEqual([
      ["start", 0],
      ["move", 16],
      ["end", 32],
    ]);
    expect(commands()).toEqual([]);
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
    // RPC must fence even when the local animation-frame send is pending.
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
