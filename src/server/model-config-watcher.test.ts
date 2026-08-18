import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ModelConfigWatcher } from "./model-config-watcher";

const tempDirs: string[] = [];

async function createModelsPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-model-config-watcher-"));
  tempDirs.push(directory);
  return path.join(directory, "models.json");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("model config watcher", () => {
  it("reloads models.json without allowing network access", async () => {
    const modelsPath = await createModelsPath();
    const runtime = {
      refresh: vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() })),
      getError: vi.fn(() => undefined),
    };
    const watcher = new ModelConfigWatcher(modelsPath, runtime);
    await watcher.initialize();

    try {
      await fs.writeFile(modelsPath, '{"providers":{}}');
      await vi.waitFor(() => {
        expect(runtime.refresh).toHaveBeenCalledWith({ allowNetwork: false });
      });
    } finally {
      await watcher.dispose();
    }
  });

  it("coalesces changes that arrive during a refresh", async () => {
    const modelsPath = await createModelsPath();
    const firstRefresh = deferred();
    const runtime = {
      refresh: vi
        .fn()
        .mockImplementationOnce(() => firstRefresh.promise)
        .mockResolvedValue({ aborted: false, errors: new Map<string, Error>() }),
      getError: vi.fn(() => undefined),
    };
    const watcher = new ModelConfigWatcher(modelsPath, runtime);
    await watcher.initialize();

    try {
      await fs.writeFile(modelsPath, '{"providers":{"first":{}}}');
      await vi.waitFor(() => expect(runtime.refresh).toHaveBeenCalledTimes(1));

      await fs.writeFile(modelsPath, '{"providers":{"second":{}}}');
      await new Promise((resolve) => setTimeout(resolve, 300));
      firstRefresh.resolve();

      await vi.waitFor(() => expect(runtime.refresh).toHaveBeenCalledTimes(2));
      expect(runtime.refresh).toHaveBeenNthCalledWith(2, { allowNetwork: false });
    } finally {
      firstRefresh.resolve();
      await watcher.dispose();
    }
  });
});
