import { afterEach, expect, test, vi } from "vite-plus/test";
import { useBrowserFrames } from "./frames";
import type { RemoteFrame } from "./types";

function packet(frame: RemoteFrame): ArrayBuffer {
  const metadata = new TextEncoder().encode(JSON.stringify(frame));
  const data = new Uint8Array(4 + metadata.length);
  new DataView(data.buffer).setUint32(0, metadata.length);
  data.set(metadata, 4);
  return data.buffer;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("a decoder crossing reconnect ACKs the old socket but paints only the new Retina frame", async () => {
  vi.stubGlobal("WebSocket", { OPEN: 1 });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    void Promise.resolve().then(() => callback(0));
    return 1;
  });
  let resolveOld!: (bitmap: ImageBitmap) => void;
  const oldDecoded = new Promise<ImageBitmap>((resolve) => {
    resolveOld = resolve;
  });
  const oldBitmap = { width: 358, height: 757, close: vi.fn() } as unknown as ImageBitmap;
  const bitmap = { width: 1074, height: 2271, close: vi.fn() } as unknown as ImageBitmap;
  const decode = vi.fn().mockReturnValueOnce(oldDecoded).mockResolvedValueOnce(bitmap);
  vi.stubGlobal("createImageBitmap", decode);
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
  const frame = { pageId: "page", revision: "current", width: 358, height: 757, frameId: 1 };
  frames.receive(packet(frame), oldSocket, generation);
  frames.stop();
  generation++;
  currentSocket = socket;
  frames.receive(packet({ ...frame, frameId: 2 }), socket, generation);
  expect(decode).toHaveBeenCalledTimes(1);

  resolveOld(oldBitmap);
  await vi.waitFor(() => expect(onLive).toHaveBeenCalledTimes(1));

  expect(drawImage).toHaveBeenCalledExactlyOnceWith(bitmap, 0, 0);
  expect(frames.image.value.width).toBe(1074);
  expect(frames.image.value.height).toBe(2271);
  expect(frames.displayedFrame.value).toEqual({ ...frame, frameId: 2 });
  expect(oldBitmap.close).toHaveBeenCalledOnce();
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(oldSocket.send).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ action: "ack", frameId: 1 }),
  );
  expect(socket.send).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ action: "ack", frameId: 2 }),
  );
  expect(onDecodeError).not.toHaveBeenCalled();
});
