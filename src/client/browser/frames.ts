import { ref } from "vue";
import type { CloudBrowserState } from "@/shared/cloud-browser";
import type { RemoteFrame } from "./types";

// One latest-frame slot keeps decoding bounded; every consumed/replaced frame is ACKed.
export function useBrowserFrames({
  getGeneration,
  getSocket,
  getState,
  onLive,
  onDecodeError,
}: {
  getGeneration: () => number;
  getSocket: () => WebSocket | undefined;
  getState: () => CloudBrowserState | undefined;
  onLive: () => void;
  onDecodeError: (error: Error) => void;
}) {
  const image = ref<HTMLCanvasElement>();
  const displayedFrame = ref<RemoteFrame>();
  const hasFrame = ref(false);
  let pendingFrame:
    | { frame: RemoteFrame; jpeg: Blob; socket: WebSocket; generation: number }
    | undefined;
  let painting = false;

  function receive(data: ArrayBuffer, socket: WebSocket, generation: number): void {
    const length = new DataView(data).getUint32(0);
    const frame = JSON.parse(
      new TextDecoder().decode(new Uint8Array(data, 4, length)),
    ) as RemoteFrame;
    if (pendingFrame) acknowledge(pendingFrame.socket, pendingFrame.frame.frameId);
    pendingFrame = {
      frame,
      jpeg: new Blob([data.slice(4 + length)], { type: "image/jpeg" }),
      socket,
      generation,
    };
    void paintFrames();
  }
  function stop(): void {
    pendingFrame = undefined;
  }
  function acknowledge(socket: WebSocket, frameId: number): void {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ action: "ack", frameId }));
  }
  async function paintFrames(): Promise<void> {
    if (painting) return;
    painting = true;
    let decodingGeneration = getGeneration();
    try {
      while (pendingFrame) {
        const next = pendingFrame;
        decodingGeneration = next.generation;
        pendingFrame = undefined;
        const bitmap = await createImageBitmap(next.jpeg);
        try {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          if (next.generation !== getGeneration() || next.socket !== getSocket()) continue;
          if (
            next.frame.pageId === getState()?.pageId &&
            next.frame.revision === getState()?.revision
          ) {
            const canvas = image.value!;
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
            }
            canvas.getContext("2d", { alpha: false })!.drawImage(bitmap, 0, 0);
            displayedFrame.value = next.frame;
            hasFrame.value = true;
            canvas.dataset.frame = String(next.frame.frameId);
            onLive();
          }
        } finally {
          bitmap.close();
          acknowledge(next.socket, next.frame.frameId);
        }
      }
    } catch (cause) {
      if (decodingGeneration === getGeneration()) {
        onDecodeError(cause as Error);
      }
    } finally {
      painting = false;
      if (pendingFrame) void paintFrames();
    }
  }

  return { image, displayedFrame, hasFrame, receive, stop };
}
