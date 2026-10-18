import { afterEach, expect, test, vi } from "vite-plus/test";
import { useBrowserFrames } from "./frames";
import type { RemoteFrame } from "./types";

function packet(frame: RemoteFrame): ArrayBuffer {
  const metadata = new TextEncoder().encode(JSON.stringify(frame));
  const data = new Uint8Array(4 + metadata.length + 5);
  new DataView(data.buffer).setUint32(0, metadata.length);
  data.set(metadata, 4);
  data.set([0, 0, 0, 1, 0x65], 4 + metadata.length);
  return data.buffer;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("a pending support check crossing reconnect ACKs the old socket but decodes only the new stream", async () => {
  vi.stubGlobal("WebSocket", { OPEN: 1 });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    void Promise.resolve().then(() => callback(0));
    return 1;
  });
  let resolveOld!: (support: { supported: boolean }) => void;
  const oldSupport = new Promise<{ supported: boolean }>((resolve) => {
    resolveOld = resolve;
  });
  const video = {
    timestamp: 2,
    displayWidth: 1074,
    displayHeight: 2271,
    close: vi.fn(),
  } as unknown as VideoFrame;
  const constructed = vi.fn();
  vi.stubGlobal(
    "VideoDecoder",
    class {
      static isConfigSupported = vi
        .fn()
        .mockReturnValueOnce(oldSupport)
        .mockResolvedValue({ supported: true });
      state = "configured";
      constructor(readonly callbacks: VideoDecoderInit) {
        constructed();
      }
      configure() {}
      decode() {
        this.callbacks.output(video);
      }
    },
  );
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      constructor(init: EncodedVideoChunkInit) {
        Object.assign(this, init);
      }
    },
  );
  const oldSocket = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
  const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
  let currentSocket = oldSocket;
  let generation = 1;
  const onLive = vi.fn();
  const onDecodeError = vi.fn();
  const frames = useBrowserFrames({
    getGeneration: () => generation,
    getSocket: () => currentSocket,
    getState: () => ({
      pageId: "page",
      revision: "current",
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
  const frame: RemoteFrame = {
    pageId: "page",
    revision: "current",
    width: 358,
    height: 757,
    frameId: 1,
    codec: "avc1.42E01F",
    streamId: "stream",
    key: true,
  };
  frames.receive(packet(frame), oldSocket, generation);
  frames.stop();
  generation++;
  currentSocket = socket;
  frames.receive(packet({ ...frame, frameId: 2 }), socket, generation);
  await vi.waitFor(() => expect(onLive).toHaveBeenCalledTimes(1));
  resolveOld({ supported: true });
  await Promise.resolve();

  expect(constructed).toHaveBeenCalledOnce();
  expect(drawImage).toHaveBeenCalledExactlyOnceWith(video, 0, 0);
  expect(frames.image.value.width).toBe(1074);
  expect(frames.image.value.height).toBe(2271);
  expect(frames.displayedFrame.value).toEqual({ ...frame, frameId: 2 });
  expect(video.close).toHaveBeenCalledOnce();
  expect(oldSocket.send).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ action: "ack", frameId: 1 }),
  );
  expect(socket.send).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ action: "ack", frameId: 2 }),
  );
  expect(onDecodeError).not.toHaveBeenCalled();
});
