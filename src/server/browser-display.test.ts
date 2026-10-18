// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { createBrowserDisplay, stopBrowserDisplay } from "./browser-display";

vi.hoisted(() => vi.resetModules());
vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
afterAll(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});
let directory: string;
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-display-test-"));
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    (args.at(-1) as (error: Error | null, result: string) => void)(null, "");
    return {} as ReturnType<typeof execFile>;
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(directory, { recursive: true, force: true });
});

function fakeDisplay() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdout: new PassThrough(),
    kill: vi.fn<(signal: string) => boolean>(() => {
      child.signalCode = "SIGTERM";
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return true;
    }),
    unref: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

test("displayfd can arrive in chunks; success removes startup listeners and timer", async () => {
  vi.useFakeTimers();
  const child = fakeDisplay();
  const starting = createBrowserDisplay(directory);
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
  child.stdout.write("12");
  child.stdout.write("3\n");
  expect(await starting).toEqual({
    pid: 123,
    display: ":123",
    authority: path.join(directory, "Xauthority"),
  });
  expect(child.listenerCount("exit")).toBe(0);
  expect(child.listenerCount("error")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test("failed xauth after startup terminates Xvfb instead of leaking the display", async () => {
  const child = fakeDisplay();
  const starting = createBrowserDisplay(directory);
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    (args.at(-1) as (error: Error) => void)(new Error("xauth failed"));
    return {} as ReturnType<typeof execFile>;
  });
  const failed = expect(starting).rejects.toThrow("xauth failed");
  child.stdout.write("123\n");
  await failed;
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});

test("Xvfb spawn errors clear the startup deadline without signalling a nonexistent process", async () => {
  vi.useFakeTimers();
  const child = fakeDisplay();
  const starting = createBrowserDisplay(directory);
  const failed = expect(starting).rejects.toThrow("ENOENT");
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
  Object.assign(child, { pid: undefined });
  child.emit("error", new Error("spawn Xvfb ENOENT"));
  await failed;
  expect(vi.getTimerCount()).toBe(0);
  expect(child.kill).not.toHaveBeenCalled();
});

test("a display exiting during /proc read is already stopped", async () => {
  const read = vi
    .spyOn(fs, "readFile")
    .mockRejectedValueOnce(Object.assign(new Error("no such process"), { code: "ESRCH" }));
  const signal = vi.spyOn(process, "kill");
  try {
    await stopBrowserDisplay({
      pid: 123456,
      display: ":123",
      authority: path.join(directory, "Xauthority"),
    });
    expect(signal).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    signal.mockRestore();
  }
});

test.skipIf(process.platform !== "linux")(
  "a reused display PID cannot terminate an unrelated process",
  async () => {
    const signal = vi.spyOn(process, "kill");
    try {
      await expect(
        stopBrowserDisplay({
          pid: process.pid,
          display: ":123",
          authority: path.join(directory, "Xauthority"),
        }),
      ).rejects.toThrow("belongs to another process");
      expect(signal).not.toHaveBeenCalled();
    } finally {
      signal.mockRestore();
    }
  },
);
