// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { startNativeBrowserVideo } from "./native-browser-video";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => vi.useRealTimers());

function fakeEncoder() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn<(signal: string) => boolean>(() => true),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const fail = vi.fn();
  const output = vi.fn();
  const video = startNativeBrowserVideo(
    { display: ":123", authority: "/private/auth", x: 0, y: 0, width: 100, height: 100 },
    {
      width: 100,
      height: 100,
      pageId: "page-1",
      revision: "1",
      url: "about:blank",
      title: "",
      mobile: true,
      deviceScaleFactor: 1,
      pages: [],
    },
    1,
    output,
    fail,
  );
  return { child, fail, output, video };
}

test("parser failure stops the encoder and reports once despite more bytes/error/exit", async () => {
  const { child, fail, output, video } = fakeEncoder();
  const invalid = Buffer.from([
    0, 0, 1, 9, 0xf0, 0, 0, 1, 0x65, 0x88, 0, 0, 1, 9, 0xf0, 0, 0, 1, 0x65,
  ]);
  child.stdout.write(invalid);
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  child.stdout.write(invalid);
  child.emit("error", new Error("secondary failure"));
  child.exitCode = 1;
  child.emit("exit", 1, null);
  await video.stop();
  expect(fail).toHaveBeenCalledTimes(1);
  expect(fail.mock.calls[0]![0].message).toContain("omitted SPS");
  expect(output).not.toHaveBeenCalled();
});

test("stop escalates a hung encoder and shares one bounded stop operation", async () => {
  vi.useFakeTimers();
  const { child, video, fail } = fakeEncoder();
  const stopped = video.stop();
  expect(video.stop()).toBe(stopped);
  await vi.advanceTimersByTimeAsync(1000);
  expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  child.signalCode = "SIGKILL";
  child.emit("exit", null, "SIGKILL");
  await stopped;
  expect(fail).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("an unkillable encoder rejects stop within the deadline", async () => {
  vi.useFakeTimers();
  const { video } = fakeEncoder();
  const assertion = expect(video.stop()).rejects.toThrow("did not exit after SIGKILL");
  await vi.advanceTimersByTimeAsync(2000);
  await assertion;
});

test("spawn errors report once without waiting for an exit event that cannot happen", async () => {
  const { child, video, fail } = fakeEncoder();
  Object.assign(child, { pid: undefined });
  child.emit("error", new Error("spawn ffmpeg ENOENT"));
  await video.stop();
  expect(fail).toHaveBeenCalledTimes(1);
  expect(child.kill).not.toHaveBeenCalled();
});
