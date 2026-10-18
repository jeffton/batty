import { ref } from "vue";
import type { CloudBrowserState } from "@/shared/cloud-browser";
import type { RemoteFrame } from "./types";

// Losing any delta invalidates the GOP. Discard the whole decoder, then wait for a keyframe.
const MAX_PENDING_FRAMES = 12;

type PendingFrame = { frame: RemoteFrame; socket: WebSocket };
type Stream = {
  id: string;
  codec: string;
  pageId: string;
  revision: string;
  generation: number;
  socket: WebSocket;
  decoder?: VideoDecoder;
  pending: Map<number, PendingFrame>;
  chunks: EncodedVideoChunk[];
  paints: Map<number, { request: number; video: VideoFrame }>;
};

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
  let stream: Stream | undefined;

  function acknowledge(socket: WebSocket, frameId: number): void {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ action: "ack", frameId }));
  }
  function finish(current: Stream, frameId: number): void {
    const pending = current.pending.get(frameId);
    if (!pending) return;
    current.pending.delete(frameId);
    acknowledge(pending.socket, frameId);
  }
  function release(current: Stream): void {
    if (stream === current) stream = undefined;
    if (current.decoder && current.decoder.state !== "closed") current.decoder.close();
    current.chunks.length = 0;
    for (const { request, video } of current.paints.values()) {
      cancelAnimationFrame(request);
      video.close();
    }
    current.paints.clear();
    for (const frameId of current.pending.keys()) finish(current, frameId);
  }
  function stop(): void {
    if (stream) release(stream);
  }
  function isCurrent(current: Stream): boolean {
    const state = getState();
    return (
      stream === current &&
      current.generation === getGeneration() &&
      current.socket === getSocket() &&
      current.pageId === state?.pageId &&
      current.revision === state?.revision
    );
  }
  function fail(current: Stream, error: Error): void {
    const report = isCurrent(current);
    release(current);
    if (report) onDecodeError(error);
  }
  function output(current: Stream, video: VideoFrame): void {
    const pending = current.pending.get(video.timestamp);
    if (!pending || !isCurrent(current)) {
      video.close();
      finish(current, video.timestamp);
      return;
    }
    const request = requestAnimationFrame(() => {
      if (!current.paints.delete(video.timestamp)) return;
      try {
        if (!isCurrent(current)) return;
        const canvas = image.value!;
        if (canvas.width !== video.displayWidth || canvas.height !== video.displayHeight) {
          canvas.width = video.displayWidth;
          canvas.height = video.displayHeight;
        }
        canvas.getContext("2d", { alpha: false })!.drawImage(video, 0, 0);
        displayedFrame.value = pending.frame;
        hasFrame.value = true;
        canvas.dataset.frame = String(pending.frame.frameId);
        onLive();
      } catch (cause) {
        fail(current, cause as Error);
      } finally {
        video.close();
        finish(current, video.timestamp);
      }
    });
    current.paints.set(video.timestamp, { request, video });
  }
  async function configure(current: Stream): Promise<void> {
    try {
      if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") {
        throw new Error("This browser does not support WebCodecs H.264 decoding");
      }
      // No description: H.264 chunks carry Annex-B parameter sets in keyframes.
      const config: VideoDecoderConfig = { codec: current.codec, optimizeForLatency: true };
      const support = await VideoDecoder.isConfigSupported(config);
      if (!isCurrent(current)) {
        release(current);
        return;
      }
      if (!support.supported) throw new Error(`Unsupported browser video codec: ${current.codec}`);
      const decoder = new VideoDecoder({
        output: (video) => output(current, video),
        error: (error) => fail(current, error),
      });
      current.decoder = decoder;
      decoder.configure(config);
      for (const chunk of current.chunks) decoder.decode(chunk);
      current.chunks.length = 0;
    } catch (cause) {
      fail(current, cause as Error);
    }
  }
  function receive(data: ArrayBuffer, socket: WebSocket, generation: number): void {
    const length = new DataView(data).getUint32(0);
    const frame = JSON.parse(
      new TextDecoder().decode(new Uint8Array(data, 4, length)),
    ) as RemoteFrame;
    const state = getState();
    if (
      generation !== getGeneration() ||
      socket !== getSocket() ||
      frame.pageId !== state?.pageId ||
      frame.revision !== state?.revision
    ) {
      acknowledge(socket, frame.frameId);
      return;
    }
    if (
      stream &&
      (stream.id !== frame.streamId ||
        stream.codec !== frame.codec ||
        stream.generation !== generation ||
        stream.socket !== socket ||
        stream.pageId !== frame.pageId ||
        stream.revision !== frame.revision)
    ) {
      release(stream);
    }
    if (stream && stream.pending.size >= MAX_PENDING_FRAMES) {
      release(stream);
    }
    if (!stream && !frame.key) {
      acknowledge(socket, frame.frameId);
      return;
    }
    let starting = false;
    if (!stream) {
      stream = {
        id: frame.streamId,
        codec: frame.codec,
        pageId: frame.pageId,
        revision: frame.revision,
        generation,
        socket,
        pending: new Map(),
        chunks: [],
        paints: new Map(),
      };
      starting = true;
    }
    const current = stream;
    current.pending.set(frame.frameId, { frame, socket });
    try {
      if (typeof EncodedVideoChunk === "undefined") {
        throw new Error("This browser does not support WebCodecs H.264 decoding");
      }
      const chunk = new EncodedVideoChunk({
        type: frame.key ? "key" : "delta",
        timestamp: frame.frameId,
        data: new Uint8Array(data, 4 + length),
      });
      if (current.decoder) current.decoder.decode(chunk);
      else current.chunks.push(chunk);
      if (starting) void configure(current);
    } catch (cause) {
      fail(current, cause as Error);
    }
  }

  return { image, displayedFrame, hasFrame, receive, stop };
}
