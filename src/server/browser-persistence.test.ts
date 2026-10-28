// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { Browser } from "patchright";
import {
  closePersistentBrowser,
  connectPersistentBrowser,
  persistentBrowserDisplay,
} from "./browser-persistence";
import { createBrowserDisplay, stopBrowserDisplay } from "./browser-display";
import { chromium } from "patchright";
import { ownsBrowserProcess } from "./browser-isolation";

// Failure fixtures launch fake executables, not the installed unprivileged Chromium.
vi.mock("./browser-isolation", async (original) => {
  const actual = await original<typeof import("./browser-isolation")>();
  return {
    ...actual,
    prepareBrowserIsolation: vi.fn().mockResolvedValue(undefined),
    ownsBrowserProcess: vi.fn(actual.ownsBrowserProcess),
  };
});
vi.mock("patchright", () => ({
  chromium: { executablePath: vi.fn(), connectOverCDP: vi.fn() },
}));
vi.mock("./browser-display", () => ({
  createBrowserDisplay: vi.fn(),
  stopBrowserDisplay: vi.fn(),
}));
let directory: string;
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-launch-failure-"));
  vi.mocked(createBrowserDisplay).mockResolvedValue({
    pid: 123456,
    display: ":456",
    authority: path.join(directory, "Xauthority"),
  });
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

test("native viewing rejects a missing or dead display without replacing the browser", async () => {
  await expect(persistentBrowserDisplay(directory)).rejects.toMatchObject({ statusCode: 426 });
  expect(await fs.readdir(directory)).toEqual([]);

  const display = { pid: 123456, display: ":456", authority: path.join(directory, "Xauthority") };
  const receipt = JSON.stringify(display);
  await fs.writeFile(path.join(directory, "display.json"), receipt);
  const dead = Object.assign(new Error("Display process is gone"), { code: "ESRCH" });
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw dead;
  });
  try {
    await expect(persistentBrowserDisplay(directory)).rejects.toBe(dead);
    expect(kill).toHaveBeenCalledWith(display.pid, 0);
    expect(await fs.readFile(path.join(directory, "display.json"), "utf8")).toBe(receipt);
  } finally {
    kill.mockRestore();
  }
});

test("display cleanup still runs when closing the CDP connection rejects", async () => {
  const display = { pid: 123456, display: ":456", authority: path.join(directory, "Xauthority") };
  await fs.writeFile(path.join(directory, "display.json"), JSON.stringify(display));
  const close = vi.fn().mockRejectedValue(new Error("CDP disconnected"));
  await expect(closePersistentBrowser(directory, { close } as unknown as Browser)).rejects.toThrow(
    "Persistent browser cleanup failed",
  );
  expect(stopBrowserDisplay).toHaveBeenCalledWith(display);
});

test.skipIf(process.platform !== "linux")(
  "cancelling a stalled CDP handshake reaps startup and clears launch receipts",
  async () => {
    const executable = path.join(directory, "fake-chromium");
    await fs.writeFile(executable, "#!/bin/sh\nexec sleep 60\n", { mode: 0o700 });
    vi.mocked(chromium.executablePath).mockReturnValue(executable);
    const controller = new AbortController();
    let launchedPid: number | undefined;
    vi.mocked(chromium.connectOverCDP).mockImplementation(async () => {
      launchedPid = JSON.parse(await fs.readFile(path.join(directory, "process.json"), "utf8")).pid;
      controller.abort(new Error("CDP deadline"));
      return new Promise(() => {});
    });
    await fs.mkdir(path.join(directory, "profile"));
    await fs.writeFile(
      path.join(directory, "profile", "DevToolsActivePort"),
      "12345\n/devtools/browser/test",
    );
    await expect(
      connectPersistentBrowser(directory, { useTailscale: true }, controller.signal),
    ).rejects.toThrow("CDP deadline");
    await expectLaunchCleaned();
    expect(() => process.kill(launchedPid!, 0)).toThrow("ESRCH");
  },
);

test("a stalled CDP disconnect is bounded and does not retain dead launch receipts", async () => {
  const display = { pid: 123456, display: ":456", authority: path.join(directory, "Xauthority") };
  await fs.writeFile(path.join(directory, "display.json"), JSON.stringify(display));
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    queueMicrotask(() => controller.abort(new DOMException("Timed out", "TimeoutError")));
    return controller.signal;
  });
  try {
    await expect(
      closePersistentBrowser(directory, {
        close: () => new Promise(() => {}),
      } as unknown as Browser),
    ).rejects.toThrow("Persistent browser cleanup failed");
    expect(timeout).toHaveBeenCalledExactlyOnceWith(2000);
    expect(stopBrowserDisplay).toHaveBeenCalledWith(display);
    expect(await fs.readdir(directory)).not.toContain("display.json");
  } finally {
    timeout.mockRestore();
  }
});

test("closing bounds a stalled CDP-session creation and still clears runtime receipts", async () => {
  await fs.writeFile(path.join(directory, "process.json"), JSON.stringify({ pid: 123456 }));
  vi.mocked(ownsBrowserProcess).mockResolvedValueOnce(true);
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    queueMicrotask(() => controller.abort(new DOMException("Timed out", "TimeoutError")));
    return controller.signal;
  });
  const close = vi.fn(async () => {});
  try {
    await expect(
      closePersistentBrowser(directory, {
        newBrowserCDPSession: () => new Promise(() => {}),
        close,
      } as unknown as Browser),
    ).rejects.toThrow("Persistent browser cleanup failed");
    expect(close).toHaveBeenCalledOnce();
    await expect(fs.stat(path.join(directory, "process.json"))).rejects.toThrow("ENOENT");
  } finally {
    kill.mockRestore();
    timeout.mockRestore();
  }
});

test.skipIf(process.platform !== "linux")(
  "profile initialization retries after interrupted preferences setup",
  async () => {
    const preferences = path.join(directory, "profile", "Default", "Preferences");
    await fs.mkdir(path.dirname(preferences), { recursive: true });
    await fs.writeFile(preferences, "invalid-json");
    await expect(connectPersistentBrowser(directory, { useTailscale: false })).rejects.toThrow();
    await expect(fs.stat(path.join(directory, "profile-ready.json"))).rejects.toThrow("ENOENT");
    await fs.writeFile(preferences, JSON.stringify({ translate: { enabled: true } }));
    vi.mocked(chromium.executablePath).mockReturnValue("/nonexistent/batty-test-chromium");
    await expect(connectPersistentBrowser(directory, { useTailscale: false })).rejects.toThrow(
      "ENOENT",
    );
    expect(JSON.parse(await fs.readFile(preferences, "utf8")).translate.enabled).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(directory, "profile-ready.json"), "utf8"))).toBe(
      true,
    );
  },
);

async function expectLaunchCleaned() {
  expect(stopBrowserDisplay).toHaveBeenCalledTimes(1);
  const files = await fs.readdir(directory);
  for (const receipt of ["launch.json", "process.json", "browser.json", "display.json"])
    expect(files).not.toContain(receipt);
}

test.skipIf(process.platform !== "linux")(
  "Chromium spawn failure releases the display and launch receipts",
  async () => {
    vi.mocked(chromium.executablePath).mockReturnValue("/nonexistent/batty-test-chromium");
    await expect(connectPersistentBrowser(directory, { useTailscale: false })).rejects.toThrow(
      "ENOENT",
    );
    await expectLaunchCleaned();
  },
);

test.skipIf(process.platform !== "linux")(
  "failure opening the Chromium log still releases the display",
  async () => {
    await fs.mkdir(path.join(directory, "chromium.log"));
    await expect(connectPersistentBrowser(directory, { useTailscale: false })).rejects.toThrow(
      "EISDIR",
    );
    await expectLaunchCleaned();
  },
);

test.skipIf(process.platform !== "linux")(
  "failed initial CDP connection removes the receipt and stops both owned processes",
  async () => {
    const executable = path.join(directory, "fake-chromium");
    await fs.writeFile(executable, "#!/bin/sh\nexec sleep 60\n", { mode: 0o700 });
    vi.mocked(chromium.executablePath).mockReturnValue(executable);
    let launchedPid: number | undefined;
    vi.mocked(chromium.connectOverCDP).mockImplementation(async () => {
      launchedPid = JSON.parse(await fs.readFile(path.join(directory, "process.json"), "utf8")).pid;
      throw new Error("CDP unavailable");
    });
    await fs.mkdir(path.join(directory, "profile"));
    await fs.writeFile(
      path.join(directory, "profile", "DevToolsActivePort"),
      "12345\n/devtools/browser/test",
    );
    await expect(connectPersistentBrowser(directory, { useTailscale: false })).rejects.toThrow(
      "CDP unavailable",
    );
    await expectLaunchCleaned();
    expect(launchedPid).toBeTypeOf("number");
    expect(() => process.kill(launchedPid!, 0)).toThrow("ESRCH");
    await expect(fs.stat(path.join(directory, "profile", "DevToolsActivePort"))).rejects.toThrow(
      "ENOENT",
    );
  },
);
