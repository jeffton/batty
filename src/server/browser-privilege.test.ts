// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import { once } from "node:events";
import { spawnBrowserProcess } from "./browser-privilege";

test.each(["darwin", "win32"] as const)(
  "%s launches persistent browser children directly, without sudo",
  async (platform) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const uid = process.getuid && vi.spyOn(process, "getuid").mockReturnValue(1000);
    let child;
    try {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      child = spawnBrowserProcess(
        process.execPath,
        ["-e", "process.stdout.write(String(process.ppid))"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } finally {
      Object.defineProperty(process, "platform", descriptor);
      uid?.mockRestore();
    }
    let output = "";
    child.stdout!.on("data", (data: Buffer) => {
      output += data.toString();
    });
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    expect(Number(output)).toBe(process.pid);
  },
);
