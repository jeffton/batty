// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import {
  createCloudBrowserSocketWriter,
  encodeBrowserFrame,
  type BrowserFramePacket,
} from "./cloud-browser-events";
import type { CloudBrowserFrame } from "@/shared/cloud-browser";

function decodePacket(value: unknown): CloudBrowserFrame & { frameId: number } {
  const { packet } = value as BrowserFramePacket;
  const end = 4 + packet.readUInt32BE(0);
  return {
    ...JSON.parse(packet.subarray(4, end).toString()),
    image: packet.subarray(end).toString("base64"),
  };
}

test("binary packet retains exact H.264 bytes and decoder metadata", () => {
  const frame = {
    image: Buffer.from([0, 0, 0, 1, 0x65, 255]).toString("base64"),
    pageId: "p",
    revision: "r",
    width: 390,
    height: 640,
    codec: "avc1.42c01f",
    key: true,
    streamId: "encoder",
  };
  expect(decodePacket(encodeBrowserFrame(frame, 42))).toEqual({ ...frame, frameId: 42 });
});

test("slow viewers bound socket writes and recover an overflowing GOP only at a keyframe", () => {
  const writes: Array<string | Buffer> = [];
  const callbacks: Array<(error?: Error) => void> = [];
  const socket = {
    readyState: 1,
    send(value: string | Buffer, _options: unknown, callback: (error?: Error) => void) {
      writes.push(value);
      callbacks.push(callback);
    },
    close: vi.fn(),
    terminate: vi.fn(),
  };
  const writer = createCloudBrowserSocketWriter(
    socket as unknown as Parameters<typeof createCloudBrowserSocketWriter>[0],
  );
  const paint = (frameId: number) =>
    encodeBrowserFrame(
      {
        image: "//g=",
        pageId: "p",
        revision: "r",
        width: 390,
        height: 640,
        codec: "avc1.42c01f",
        streamId: "encoder",
        key: frameId === 1 || frameId === 100,
      },
      frameId,
    );
  writer.send("frame", paint(1));
  writer.send("state", { pageId: "old" });
  writer.send("state", { pageId: "new" });
  writer.send("frame", paint(2));
  expect(writes).toHaveLength(1);
  callbacks.shift()!(); // First socket write completed, latest state wins.
  expect(JSON.parse(writes[1] as string)).toEqual({ event: "state", data: { pageId: "new" } });
  callbacks.shift()!();
  callbacks.shift()!();
  writer.send("frame", paint(3));
  callbacks.shift()!();
  writer.send("frame", paint(4));
  callbacks.shift()!();
  for (let i = 5; i <= 100; i++) writer.send("frame", paint(i));
  expect(writes).toHaveLength(5); // Four decoder ACKs are outstanding; queued GOPs overflow.
  expect(() => writer.acknowledge(99)).toThrow("Invalid browser frame acknowledgement");
  writer.acknowledge(1);
  expect(decodePacket({ packet: writes[5] }).frameId).toBe(100);
  callbacks.shift()!();
  expect(() => writer.acknowledge(1)).toThrow("Invalid browser frame acknowledgement");
  writer.close();
  writer.send("frame", paint(101));
  expect(writes).toHaveLength(6);
});

test("scroll drain fences have priority over paints and cannot replace a queued fence", () => {
  const writes: Array<string | Buffer> = [];
  const callbacks: Array<(error?: Error) => void> = [];
  const socket = {
    readyState: 1,
    send(value: string | Buffer, _options: unknown, callback: (error?: Error) => void) {
      writes.push(value);
      callbacks.push(callback);
    },
    close: vi.fn(),
    terminate: vi.fn(),
  };
  const writer = createCloudBrowserSocketWriter(
    socket as unknown as Parameters<typeof createCloudBrowserSocketWriter>[0],
  );
  const sent = vi.fn();
  writer.send(
    "frame",
    encodeBrowserFrame(
      {
        image: "//g=",
        pageId: "p",
        revision: "r",
        width: 390,
        height: 640,
        codec: "avc1.42c01f",
        streamId: "encoder",
        key: true,
      },
      1,
    ),
  );
  writer.send("state", { pageId: "p" });
  writer.send("scroll-drained", { requestId: 1 }, sent);
  expect(() => writer.send("scroll-drained", { requestId: 2 })).toThrow("already pending");
  writer.send("scroll-error", { error: "Rejected scroll.", statusCode: 409 });
  callbacks.shift()!();
  expect(JSON.parse(writes[1] as string).event).toBe("scroll-error");
  callbacks.shift()!();
  expect(JSON.parse(writes[2] as string)).toEqual({
    event: "scroll-drained",
    data: { requestId: 1 },
  });
  expect(sent).not.toHaveBeenCalled();
  callbacks.shift()!();
  expect(sent).toHaveBeenCalledOnce();
  expect(JSON.parse(writes[3] as string).event).toBe("state");
  writer.close();
});

function videoWriterFixture() {
  const packets: Buffer[] = [];
  const callbacks: Array<(error?: Error) => void> = [];
  const socket = {
    readyState: 1,
    send(value: string | Buffer, _options: unknown, callback: (error?: Error) => void) {
      if (Buffer.isBuffer(value)) packets.push(value);
      callbacks.push(callback);
    },
    close: vi.fn(),
    terminate: vi.fn(),
  };
  const writer = createCloudBrowserSocketWriter(
    socket as unknown as Parameters<typeof createCloudBrowserSocketWriter>[0],
  );
  const frame = (id: number, key = false, streamId = "first", bytes = 4) =>
    writer.send(
      "frame",
      encodeBrowserFrame(
        {
          image: Buffer.alloc(bytes).toString("base64"),
          pageId: "p",
          revision: "r",
          width: 390,
          height: 640,
          codec: "avc1.42c01f",
          key,
          streamId,
        },
        id,
      ),
    );
  return {
    writer,
    socket,
    frame,
    complete: (error?: Error) => callbacks.shift()!(error),
    ids: () => packets.map((packet) => decodePacket({ packet }).frameId),
  };
}

test("a newly attached decoder waits for a keyframe and preserves every dependent delta in order", () => {
  const f = videoWriterFixture();
  f.frame(1); // Joining an existing producer mid-GOP cannot initialize the decoder.
  expect(f.ids()).toEqual([]);
  f.frame(2, true);
  f.frame(3);
  f.frame(4);
  f.frame(5);
  f.frame(6);
  f.frame(7);
  expect(f.ids()).toEqual([2]); // At most one socket write is active.
  f.complete();
  f.complete();
  f.complete();
  f.complete();
  expect(f.ids()).toEqual([2, 3, 4, 5]); // Four frames await decoder ACKs; later deltas stay queued.
  f.writer.acknowledge(2);
  expect(f.ids()).toEqual([2, 3, 4, 5, 6]);
  f.complete();
  f.writer.acknowledge(3);
  expect(f.ids()).toEqual([2, 3, 4, 5, 6, 7]);
  f.complete();
  expect(() => f.writer.acknowledge(2)).toThrow("Invalid browser frame acknowledgement");
  expect(() => f.writer.acknowledge(99)).toThrow("Invalid browser frame acknowledgement");
  f.writer.close();
});

test("the ninth queued dependent frame overflows the GOP and waits for a fresh keyframe", () => {
  const f = videoWriterFixture();
  for (let id = 1; id <= 4; id++) {
    f.frame(id, id === 1);
    f.complete();
  }
  for (let id = 5; id <= 12; id++) f.frame(id);
  expect(f.ids()).toEqual([1, 2, 3, 4]);
  f.writer.acknowledge(1);
  expect(f.ids()).toEqual([1, 2, 3, 4, 5]); // Eight queued frames fit without dropping deltas.
  f.complete();
  f.frame(13);
  f.frame(14); // Nine queued frames now exceed the frame-count bound.
  f.writer.acknowledge(2);
  expect(f.ids()).toEqual([1, 2, 3, 4, 5]);
  f.frame(15);
  expect(f.ids()).toEqual([1, 2, 3, 4, 5]); // Later deltas cannot recover the broken GOP.
  f.frame(16, true);
  expect(f.ids()).toEqual([1, 2, 3, 4, 5, 16]);
  f.complete();
  f.writer.close();
});

test("encoder changes and byte-budget overflow both require a fresh keyframe", () => {
  const f = videoWriterFixture();
  f.frame(1, true);
  f.complete();
  f.frame(2);
  f.complete();
  f.frame(3);
  f.complete();
  f.frame(4);
  f.complete();
  f.frame(5, false, "first", 1024 * 1024);
  f.frame(6, false, "first", 1024 * 1024); // Exceeds 2 MiB including metadata.
  f.writer.acknowledge(1);
  expect(f.ids()).toEqual([1, 2, 3, 4]);
  f.frame(7);
  expect(f.ids()).toEqual([1, 2, 3, 4]);
  f.frame(8, true);
  f.complete();
  f.writer.acknowledge(2);
  f.frame(9, false, "new-encoder");
  expect(f.ids()).toEqual([1, 2, 3, 4, 8]);
  f.frame(10, true, "new-encoder");
  expect(f.ids()).toEqual([1, 2, 3, 4, 8, 10]);
  f.complete();
  f.writer.close();
});

test("write errors terminate transport and terminal browser errors close only after their write", () => {
  const failed = videoWriterFixture();
  failed.frame(1, true);
  failed.complete(new Error("socket lost"));
  failed.frame(2);
  expect(failed.socket.terminate).toHaveBeenCalledOnce();
  expect(failed.ids()).toEqual([1]);
  const ended = videoWriterFixture();
  ended.frame(1, true);
  ended.writer.send("browser-error", { error: "expired", statusCode: 410, retryable: false });
  ended.frame(2);
  ended.complete();
  expect(ended.socket.close).not.toHaveBeenCalled();
  ended.complete();
  expect(ended.socket.close).toHaveBeenCalledWith(1000, "Browser stream ended");
  expect(ended.ids()).toEqual([1]);
});
