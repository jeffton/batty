import type { WebSocket } from "ws";
import type { CloudBrowserFrame } from "@/shared/cloud-browser";

export interface BrowserFramePacket {
  frameId: number;
  packet: Buffer;
  key: boolean;
  streamId: string;
}

/** One encoding per captured paint, shared by all viewers. */
export function encodeBrowserFrame(frame: CloudBrowserFrame, frameId: number): BrowserFramePacket {
  const { image, ...dimensions } = frame;
  const metadata = Buffer.from(JSON.stringify({ frameId, ...dimensions }));
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(metadata.length);
  return {
    frameId,
    key: frame.key,
    streamId: frame.streamId,
    packet: Buffer.concat([length, metadata, Buffer.from(image, "base64")]),
  };
}

type Socket = Pick<WebSocket, "readyState" | "send" | "close" | "terminate">;

/** Bounded GOP queue. Dropping dependent video waits for a fresh keyframe. */
export function createCloudBrowserSocketWriter(socket: Socket) {
  const outstanding = new Set<number>();
  let frames: BrowserFramePacket[] = [];
  let streamId: string | undefined;
  let waitingForKeyframe = true;
  let state: unknown;
  let failure: unknown;
  let scrollError: unknown;
  let scrollDrained: { value: unknown; sent?: () => void } | undefined;
  let writing = false;
  let closed = false;
  const write = (value: string | Buffer, terminal = false, sent?: () => void) => {
    writing = true;
    socket.send(value, { binary: Buffer.isBuffer(value) }, (error) => {
      writing = false;
      if (error) {
        closed = true;
        socket.terminate();
      } else if (terminal) {
        closed = true;
        socket.close(1000, "Browser stream ended");
      } else {
        sent?.();
        flush();
      }
    });
  };
  const flush = () => {
    if (closed || writing || socket.readyState !== 1) return;
    if (failure !== undefined) {
      const value = failure;
      failure = undefined;
      write(JSON.stringify({ event: "browser-error", data: value }), true);
    } else if (scrollError !== undefined) {
      const value = scrollError;
      scrollError = undefined;
      write(JSON.stringify({ event: "scroll-error", data: value }));
    } else if (scrollDrained !== undefined) {
      const { value, sent } = scrollDrained;
      scrollDrained = undefined;
      write(JSON.stringify({ event: "scroll-drained", data: value }), false, sent);
    } else if (state !== undefined) {
      const value = state;
      state = undefined;
      write(JSON.stringify({ event: "state", data: value }));
    } else if (frames.length && outstanding.size < 4) {
      const value = frames.shift()!;
      outstanding.add(value.frameId);
      write(value.packet);
    }
  };
  return {
    send(
      event: "frame" | "state" | "browser-error" | "scroll-error" | "scroll-drained",
      value: unknown,
      sent?: () => void,
    ) {
      if (closed) return;
      if (event === "frame") {
        const frame = value as BrowserFramePacket;
        if (frame.streamId !== streamId) {
          frames = [];
          waitingForKeyframe = true;
          streamId = frame.streamId;
        }
        if (frame.key) {
          frames = [];
          waitingForKeyframe = false;
        }
        if (!waitingForKeyframe) {
          if (
            frames.length >= 8 ||
            frames.reduce((bytes, queued) => bytes + queued.packet.length, frame.packet.length) >
              2 * 1024 * 1024
          ) {
            frames = [];
            waitingForKeyframe = true;
          } else frames.push(frame);
        }
      } else if (event === "state") state = value;
      else if (event === "scroll-error") scrollError = value;
      else if (event === "scroll-drained") {
        if (scrollDrained) throw new Error("Browser scroll fence is already pending.");
        scrollDrained = { value, sent };
      } else failure = value;
      flush();
    },
    acknowledge(frameId: number) {
      if (!outstanding.delete(frameId)) throw new Error("Invalid browser frame acknowledgement.");
      flush();
    },
    close() {
      closed = true;
      outstanding.clear();
      frames = [];
      state = undefined;
      failure = undefined;
      scrollError = undefined;
      scrollDrained = undefined;
    },
  };
}
