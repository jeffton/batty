import type { WebSocket } from "ws";
import type { CloudBrowserFrame } from "@/shared/cloud-browser";

export interface BrowserFramePacket {
  frameId: number;
  packet: Buffer;
}

/** One encoding per captured paint, shared by all viewers. */
export function encodeBrowserFrame(frame: CloudBrowserFrame, frameId: number): BrowserFramePacket {
  const { image, ...dimensions } = frame;
  const metadata = Buffer.from(JSON.stringify({ frameId, ...dimensions }));
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(metadata.length);
  return { frameId, packet: Buffer.concat([length, metadata, Buffer.from(image, "base64")]) };
}

type Socket = Pick<WebSocket, "readyState" | "send" | "close" | "terminate">;

/** Two presented-but-unacknowledged frames and one replaceable latest paint, never history. */
export function createCloudBrowserSocketWriter(socket: Socket) {
  const outstanding = new Set<number>();
  let frame: BrowserFramePacket | undefined;
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
    } else if (frame && outstanding.size < 2) {
      const value = frame;
      frame = undefined;
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
      if (event === "frame") frame = value as BrowserFramePacket;
      else if (event === "state") state = value;
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
      frame = undefined;
      state = undefined;
      failure = undefined;
      scrollError = undefined;
      scrollDrained = undefined;
    },
  };
}
