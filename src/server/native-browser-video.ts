import { spawn } from "node:child_process";
import { stopBrowserChild } from "./browser-process";
import { randomUUID } from "node:crypto";
import type { CloudBrowserFrame, CloudBrowserState } from "@/shared/cloud-browser";

export interface NativeCaptureGeometry {
  display: string;
  authority: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Annex-B access units, bounded by AUD. No delta frame is independently disposable. */
export class H264AccessUnits {
  private pending = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private partsBytes = 0;
  private static readonly maxUnitBytes = 16 * 1024 * 1024;
  private key = false;
  private codec = "";

  constructor(private readonly output: (data: Buffer, key: boolean, codec: string) => void) {}

  push(data: Buffer): void {
    this.pending = Buffer.concat([this.pending, data]);
    const starts: number[] = [];
    for (let i = 0; i < this.pending.length - 3; i++) {
      if (
        this.pending[i] === 0 &&
        this.pending[i + 1] === 0 &&
        (this.pending[i + 2] === 1 || (this.pending[i + 2] === 0 && this.pending[i + 3] === 1))
      ) {
        starts.push(i);
        i += this.pending[i + 2] === 1 ? 2 : 3;
      }
    }
    for (let i = 0; i < starts.length - 1; i++)
      this.nal(this.pending.subarray(starts[i], starts[i + 1]));
    if (starts.length) this.pending = Buffer.from(this.pending.subarray(starts.at(-1)));
    if (this.partsBytes + this.pending.length > H264AccessUnits.maxUnitBytes)
      throw new Error("H.264 encoder access unit exceeds limit");
  }

  private nal(data: Buffer): void {
    const offset = data[2] === 1 ? 3 : 4;
    const type = data[offset]! & 31;
    if (type === 9 && this.parts.length) {
      if (!this.codec) throw new Error("H.264 encoder omitted SPS");
      this.output(Buffer.concat(this.parts), this.key, this.codec);
      this.parts = [];
      this.partsBytes = 0;
      this.key = false;
    }
    if (type === 7) this.codec = `avc1.${data.subarray(offset + 1, offset + 4).toString("hex")}`;
    if (type === 5) this.key = true;
    if (this.parts.length >= 16_384)
      throw new Error("H.264 encoder access unit NAL count exceeds limit");
    if (this.partsBytes + data.length > H264AccessUnits.maxUnitBytes)
      throw new Error("H.264 encoder access unit exceeds limit");
    // Copy NALs so a small retained unit cannot pin an entire stdout chunk.
    this.parts.push(Buffer.from(data));
    this.partsBytes += data.length;
  }
}

/** One native encoder per viewed browser. Private X display ownership is supplied by the session. */
export function startNativeBrowserVideo(
  geometry: NativeCaptureGeometry,
  state: CloudBrowserState,
  density: number,
  output: (frame: CloudBrowserFrame) => void,
  onError: (error: Error) => void,
): { stop: () => Promise<void> } {
  const streamId = randomUUID();
  const width = Math.ceil((state.width * density) / 2) * 2;
  const height = Math.ceil((state.height * density) / 2) * 2;
  const encoder = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "x11grab",
      "-draw_mouse",
      "0",
      "-video_size",
      `${geometry.width}x${geometry.height}`,
      "-framerate",
      "30",
      "-i",
      `${geometry.display}+${geometry.x},${geometry.y}`,
      "-vf",
      `scale=${width}:${height}:flags=bilinear:out_color_matrix=bt709`,
      "-an",
      "-c:v",
      "libx264",
      "-threads",
      "2",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-profile:v",
      "baseline",
      "-pix_fmt",
      "yuv420p",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-color_range",
      "tv",
      "-crf",
      "18",
      "-g",
      "30",
      "-bf",
      "0",
      "-x264-params",
      "repeat-headers=1:aud=1",
      "-flush_packets",
      "1",
      "-f",
      "h264",
      "pipe:1",
    ],
    { env: { ...process.env, XAUTHORITY: geometry.authority }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stopped = false;
  let failure = "";
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopped = true;
    stopping ??= stopBrowserChild(encoder);
    return stopping;
  };
  const fail = (error: Error) => {
    if (stopped) return;
    void stop().then(
      () => onError(error),
      (cleanupError) => onError(new AggregateError([error, cleanupError], error.message)),
    );
  };
  const units = new H264AccessUnits((data, key, codec) => {
    if (!stopped)
      output({
        image: data.toString("base64"),
        key,
        codec,
        streamId,
        pageId: state.pageId,
        revision: state.revision,
        width: state.width,
        height: state.height,
      });
  });
  encoder.stdout.on("data", (data: Buffer) => {
    if (stopped) return;
    try {
      units.push(data);
    } catch (error) {
      fail(error as Error);
    }
  });
  encoder.stderr.on("data", (data: Buffer) => {
    failure = (failure + data.toString()).slice(-4000);
  });
  encoder.on("error", fail);
  encoder.on("exit", (code, signal) => {
    if (!stopped) fail(new Error(`Native browser video exited (${code ?? signal}): ${failure}`));
  });
  return { stop };
}
