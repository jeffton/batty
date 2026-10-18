// @vitest-environment node
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { BrowserService } from "./browser-service";
import { CloudBrowserStreams, type NativeCaptureFactory } from "./cloud-browser-stream";
import type { CloudBrowserFrame, CloudBrowserState } from "@/shared/cloud-browser";
import type { BrowserFramePacket } from "./cloud-browser-events";

function fixture() {
  vi.useFakeTimers();
  let state: CloudBrowserState = {
    pageId: "page",
    revision: "initial",
    width: 358,
    height: 757,
    deviceScaleFactor: 3,
    mobile: true,
    url: "https://example.com",
    title: "",
    pages: [],
  };
  const page = {};
  const target = vi.fn(async () => ({ page, state }));
  const captures: Array<{
    frame: (value: CloudBrowserFrame) => void;
    error: (value: Error) => void;
    density: number;
    state: CloudBrowserState;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  let gate: Promise<void> | undefined;
  const factory: NativeCaptureFactory = vi.fn(async (next, density, frame, error) => {
    const capture = { frame, error, density, state: next.state, stop: vi.fn(async () => {}) };
    captures.push(capture);
    await gate;
    return capture;
  });
  const browser = {
    cloudTarget: target,
    cloudCaptureTarget: target,
    cloudState: vi.fn(async () => state),
  } as unknown as BrowserService;
  const streams = new CloudBrowserStreams(browser, factory);
  const events: Array<{ event: string; data: unknown }> = [];
  return {
    streams,
    captures,
    target,
    factory,
    events,
    subscribe: () => streams.subscribe("id", (event, data) => events.push({ event, data })),
    block: (value: Promise<void>) => {
      gate = value;
    },
    rotate: () => {
      state = { ...state, revision: "rotated", width: 757, height: 358 };
    },
    paint(index: number, key = true) {
      const capture = captures[index]!;
      capture.frame({
        image: Buffer.from([0, 0, 1, key ? 0x65 : 0x41]).toString("base64"),
        codec: "avc1.42c01f",
        key,
        streamId: `encoder-${index}`,
        pageId: capture.state.pageId,
        revision: capture.state.revision,
        width: capture.state.width,
        height: capture.state.height,
      });
    },
    frames: () =>
      events
        .filter((event) => event.event === "frame")
        .map(({ data }) => {
          const { packet } = data as BrowserFramePacket;
          return JSON.parse(packet.subarray(4, 4 + packet.readUInt32BE(0)).toString());
        }),
  };
}

afterEach(() => vi.useRealTimers());

test("rotation fences obsolete native callbacks and retains CSS dimensions", async () => {
  const f = fixture();
  try {
    await f.subscribe();
    f.paint(0);
    f.rotate();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.captures[0]!.stop).toHaveBeenCalledOnce();
    f.paint(0);
    f.captures[0]!.error(new Error("late encoder failure"));
    f.paint(1);
    expect(f.frames()).toMatchObject([
      { revision: "initial", width: 358, height: 757, streamId: "encoder-0" },
      { revision: "rotated", width: 757, height: 358, streamId: "encoder-1" },
    ]);
    expect(f.events.some(({ event }) => event === "browser-error")).toBe(false);
  } finally {
    await f.streams.close();
  }
});

test("close while native startup awaits stops the late producer without resurrecting polling", async () => {
  const f = fixture();
  let release!: () => void;
  f.block(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const subscribing = f.subscribe();
  await vi.advanceTimersByTimeAsync(0);
  await f.streams.close();
  release();
  const stop = await subscribing;
  f.paint(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.captures).toHaveLength(1);
  expect(f.captures[0]!.stop).toHaveBeenCalledOnce();
  expect(f.frames()).toEqual([]);
  expect(f.target).toHaveBeenCalledOnce();
  stop();
});

test("motion lowers density once, a held finger keeps it, and inertia delays sharp idle capture", async () => {
  const f = fixture();
  try {
    const stop = await f.subscribe();
    f.streams.scrolling("id", true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.captures.map(({ density }) => density)).toEqual([3, 2]);
    f.streams.scrolling("id", false);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.captures).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.captures.map(({ density }) => density)).toEqual([3, 2, 3]);
    f.streams.scrolling("id");
    await vi.advanceTimersByTimeAsync(100);
    f.streams.scrolling("id");
    await vi.advanceTimersByTimeAsync(149);
    expect(f.captures).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.captures).toHaveLength(5);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    f.streams.scrolling("id", true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.captures).toHaveLength(5);
    expect(f.captures.every(({ stop }) => stop.mock.calls.length === 1)).toBe(true);
  } finally {
    await f.streams.close();
  }
});

test("viewers share one producer without replaying an obsolete frame and last detach cleans up", async () => {
  const f = fixture();
  try {
    const first = await f.subscribe();
    f.paint(0);
    const newcomer = vi.fn();
    const second = await f.streams.subscribe("id", newcomer);
    expect(newcomer.mock.calls.map(([event]) => event)).toEqual(["state"]);
    expect(f.captures).toHaveLength(1);
    first();
    expect(f.captures[0]!.stop).not.toHaveBeenCalled();
    f.paint(0);
    expect(newcomer.mock.calls.map(([event]) => event)).toEqual(["state", "frame"]);
    second();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.captures[0]!.stop).toHaveBeenCalledOnce();
    const before = newcomer.mock.calls.length;
    f.paint(0);
    expect(newcomer).toHaveBeenCalledTimes(before);
  } finally {
    await f.streams.close();
  }
});

test("encoder failure terminates capture, while service close reports a retryable disconnect", async () => {
  const f = fixture();
  try {
    await f.subscribe();
    f.captures[0]!.error(new Error("encoder exited"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events.at(-1)).toEqual({
      event: "browser-error",
      data: { error: "encoder exited", retryable: false },
    });
    expect(f.captures[0]!.stop).toHaveBeenCalledOnce();
    f.paint(0);
    expect(f.frames()).toEqual([]);
    await f.subscribe();
    await f.streams.close();
    expect(f.events.at(-1)).toEqual({
      event: "browser-error",
      data: { error: "Browser viewer disconnected.", retryable: true },
    });
    expect(f.captures[1]!.stop).toHaveBeenCalledOnce();
  } finally {
    await f.streams.close();
  }
});

test("navigation winning capture setup discards the stale view and starts the authoritative view", async () => {
  const f = fixture();
  vi.mocked(f.factory).mockRejectedValueOnce(
    Object.assign(new Error("The browser view changed"), { statusCode: 409 }),
  );
  try {
    await f.subscribe();
    f.rotate();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.captures).toHaveLength(1);
    expect(f.captures[0]!.state.revision).toBe("rotated");
    expect(f.events.some(({ event }) => event === "browser-error")).toBe(false);
  } finally {
    await f.streams.close();
  }
});

test("failed asynchronous capture creation rejects subscription and releases the stream slot", async () => {
  const f = fixture();
  vi.mocked(f.factory).mockRejectedValueOnce(new Error("cannot start encoder"));
  await expect(f.subscribe()).rejects.toThrow("cannot start encoder");
  try {
    await f.subscribe();
    expect(f.factory).toHaveBeenCalledTimes(2);
  } finally {
    await f.streams.close();
  }
});

test("transient navigation errors during status polling reconnect without classifying encoder failures as transient", async () => {
  const f = fixture();
  try {
    await f.subscribe();
    f.target.mockRejectedValueOnce(
      new Error("Execution context was destroyed, most likely because of a navigation"),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(f.events.at(-1)).toMatchObject({ event: "browser-error", data: { retryable: true } });
    expect(f.captures[0]!.stop).toHaveBeenCalledOnce();
    await f.subscribe();
    f.captures[1]!.error(new Error("Native browser video exited (1): unknown encoder"));
    expect(f.events.at(-1)).toMatchObject({ event: "browser-error", data: { retryable: false } });
  } finally {
    await f.streams.close();
  }
});

test("capture polling failure preserves permanent expiry status and stops the native producer", async () => {
  const f = fixture();
  try {
    await f.subscribe();
    f.target.mockRejectedValueOnce(
      Object.assign(new Error("Browser session ended."), { statusCode: 410 }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(f.events.at(-1)).toEqual({
      event: "browser-error",
      data: { error: "Browser session ended.", statusCode: 410, retryable: false },
    });
    expect(f.captures[0]!.stop).toHaveBeenCalledOnce();
  } finally {
    await f.streams.close();
  }
});
