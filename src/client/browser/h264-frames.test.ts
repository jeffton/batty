import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { useBrowserFrames } from "./frames";
import type { RemoteFrame } from "./types";

class FakeDecoder {
  static instances: FakeDecoder[] = [];
  static isConfigSupported = vi.fn(async () => ({ supported: true }));
  state = "unconfigured";
  chunks: EncodedVideoChunk[] = [];
  constructor(readonly callbacks: VideoDecoderInit) {
    FakeDecoder.instances.push(this);
  }
  configure() {
    this.state = "configured";
  }
  decode(chunk: EncodedVideoChunk) {
    this.chunks.push(chunk);
  }
  close = vi.fn(() => {
    this.state = "closed";
  });
  emit(timestamp: number, width = 1074, height = 2271) {
    const video = {
      timestamp,
      displayWidth: width,
      displayHeight: height,
      close: vi.fn(),
    };
    this.callbacks.output(video as unknown as VideoFrame);
    return video;
  }
}

let paints: FrameRequestCallback[];
beforeEach(() => {
  FakeDecoder.instances = [];
  FakeDecoder.isConfigSupported.mockReset().mockResolvedValue({ supported: true });
  paints = [];
  vi.stubGlobal("WebSocket", { OPEN: 1 });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      constructor(init: EncodedVideoChunkInit) {
        Object.assign(this, init);
      }
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    paints.push(callback);
    return paints.length;
  });
});
afterEach(() => vi.unstubAllGlobals());

const base: RemoteFrame = {
  pageId: "page",
  revision: "view-1",
  width: 358,
  height: 757,
  frameId: 1,
  streamId: "stream-1",
  codec: "avc1.42E01F",
  key: true,
};
function packet(frame: RemoteFrame): ArrayBuffer {
  const metadata = new TextEncoder().encode(JSON.stringify(frame));
  const data = new Uint8Array(4 + metadata.length + 5);
  new DataView(data.buffer).setUint32(0, metadata.length);
  data.set(metadata, 4);
  data.set([0, 0, 0, 1, 0x65], 4 + metadata.length);
  return data.buffer;
}
function setup() {
  const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
  let generation = 1;
  let revision = "view-1";
  const onLive = vi.fn();
  const onDecodeError = vi.fn();
  const frames = useBrowserFrames({
    getGeneration: () => generation,
    getSocket: () => socket,
    getState: () => ({
      pageId: "page",
      revision,
      url: "https://example.org",
      title: "Example",
      width: 358,
      height: 757,
      mobile: true,
      deviceScaleFactor: 3,
      pages: [],
    }),
    onLive,
    onDecodeError,
  });
  const drawImage = vi.fn();
  frames.image.value = {
    width: 0,
    height: 0,
    dataset: {},
    getContext: () => ({ drawImage }),
  } as unknown as HTMLCanvasElement;
  return {
    frames,
    socket,
    drawImage,
    onLive,
    onDecodeError,
    receive: (overrides: Partial<RemoteFrame> = {}) =>
      frames.receive(packet({ ...base, ...overrides }), socket, generation),
    reconnect: () => generation++,
    navigate: () => (revision = "view-2"),
    acks: () =>
      vi.mocked(socket.send).mock.calls.map(([data]) => JSON.parse(data as string).frameId),
  };
}
function paint() {
  const callbacks = paints;
  paints = [];
  for (const callback of callbacks) callback(0);
}
async function configured(index = 0) {
  await vi.waitFor(() => expect(FakeDecoder.instances.length).toBe(index + 1));
  return FakeDecoder.instances[index]!;
}

test("preserves dependent chunks while support resolves, maps output metadata and ACKs after paint", async () => {
  const test = setup();
  test.receive();
  test.receive({ frameId: 2, key: false });
  const decoder = await configured();
  expect(decoder.chunks.map((chunk) => [chunk.type, chunk.timestamp])).toEqual([
    ["key", 1],
    ["delta", 2],
  ]);
  const first = decoder.emit(1);
  const second = decoder.emit(2);
  expect(test.acks()).toEqual([]);
  paint();
  expect(test.acks()).toEqual([1, 2]);
  expect(test.frames.displayedFrame.value?.frameId).toBe(2);
  expect(test.frames.image.value?.width).toBe(1074);
  expect(test.frames.image.value?.height).toBe(2271);
  expect(test.frames.image.value?.dataset.frame).toBe("2");
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).toHaveBeenCalledOnce();
  test.frames.stop();
  expect(test.acks()).toEqual([1, 2]);
});

test("stop/reconnect closes decoding and never paints a queued old generation", async () => {
  const test = setup();
  test.receive();
  const old = await configured();
  const oldVideo = old.emit(1);
  test.frames.stop();
  expect(oldVideo.close).toHaveBeenCalledOnce();
  expect(cancelAnimationFrame).toHaveBeenCalledOnce();
  expect(test.acks()).toEqual([1]);
  test.reconnect();
  test.receive({ frameId: 2, key: false });
  test.receive({ frameId: 3 });
  const decoder = await configured(1);
  const video = decoder.emit(3);
  paint();
  expect(old.close).toHaveBeenCalledOnce();
  expect(oldVideo.close).toHaveBeenCalledOnce();
  expect(video.close).toHaveBeenCalledOnce();
  expect(test.drawImage).toHaveBeenCalledExactlyOnceWith(video, 0, 0);
  expect(test.acks()).toEqual([1, 2, 3]);
});

test("view/stream rotation waits for keyframe and updates physical canvas dimensions", async () => {
  const test = setup();
  test.receive();
  const old = await configured();
  old.emit(1);
  test.navigate();
  test.receive({ frameId: 2, revision: "view-2", streamId: "stream-2", key: false });
  paint();
  expect(test.drawImage).not.toHaveBeenCalled();
  test.receive({ frameId: 3, revision: "view-2", streamId: "stream-2" });
  const decoder = await configured(1);
  decoder.emit(3, 2271, 1074);
  paint();
  expect(test.frames.image.value?.width).toBe(2271);
  expect(test.frames.image.value?.height).toBe(1074);
  expect(test.acks()).toEqual([1, 2, 3]);
});

test("backpressure discards the entire GOP, ACKs it, and recovers only on a keyframe", async () => {
  const test = setup();
  test.receive();
  const old = await configured();
  for (let frameId = 2; frameId <= 14; frameId++) test.receive({ frameId, key: false });
  expect(old.close).toHaveBeenCalledOnce();
  expect(test.acks()).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  expect(FakeDecoder.instances).toHaveLength(1);
  test.receive({ frameId: 15 });
  const decoder = await configured(1);
  expect(decoder.chunks.map((chunk) => chunk.timestamp)).toEqual([15]);
  decoder.emit(15);
  paint();
  expect(test.frames.displayedFrame.value?.frameId).toBe(15);
});

test("decoder failure ACKs dependent frames and recovers at the next keyframe", async () => {
  const test = setup();
  test.receive();
  test.receive({ frameId: 2, key: false });
  const decoder = await configured();
  decoder.callbacks.error(new DOMException("decode failed"));
  expect(test.acks()).toEqual([1, 2]);
  expect(test.onDecodeError).toHaveBeenCalledOnce();
  test.receive({ frameId: 3, key: false });
  expect(FakeDecoder.instances).toHaveLength(1);
  test.receive({ frameId: 4 });
  await configured(1);
});

test("unsupported codecs fail explicitly and release every packet", async () => {
  FakeDecoder.isConfigSupported.mockResolvedValue({ supported: false });
  const test = setup();
  test.receive();
  test.receive({ frameId: 2, key: false });
  await vi.waitFor(() => expect(test.onDecodeError).toHaveBeenCalledOnce());
  expect(test.onDecodeError.mock.calls[0]![0].message).toContain("Unsupported browser video codec");
  expect(test.acks()).toEqual([1, 2]);
  expect(FakeDecoder.instances).toHaveLength(0);
});

test("missing WebCodecs fails explicitly without bitmap fallback", () => {
  vi.stubGlobal("VideoDecoder", undefined);
  const test = setup();
  test.receive();
  expect(test.onDecodeError).toHaveBeenCalledOnce();
  expect(test.onDecodeError.mock.calls[0]![0].message).toContain("WebCodecs");
  expect(test.acks()).toEqual([1]);
});

test("a support check resolving after stop cannot create a decoder or double-ACK", async () => {
  let resolve!: (support: { supported: boolean }) => void;
  FakeDecoder.isConfigSupported.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const test = setup();
  test.receive();
  test.frames.stop();
  resolve({ supported: true });
  await Promise.resolve();
  expect(test.acks()).toEqual([1]);
  expect(FakeDecoder.instances).toHaveLength(0);
});
