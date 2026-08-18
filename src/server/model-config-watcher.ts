import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const WATCH_DEBOUNCE_MS = 200;

type RefreshableModelRuntime = Pick<ModelRuntime, "getError" | "refresh">;

export class ModelConfigWatcher {
  private watcher: FSWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;
  private refreshPromise: Promise<void> | undefined;
  private refreshAgain = false;

  constructor(
    private readonly modelsPath: string,
    private readonly modelRuntime: RefreshableModelRuntime,
  ) {}

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.modelsPath), { recursive: true });
    this.watcher = watch(path.dirname(this.modelsPath), (_eventType, fileName) => {
      if (fileName && fileName !== path.basename(this.modelsPath)) {
        return;
      }

      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = undefined;
        void this.refresh().catch((error) => {
          console.error("Failed to reload models config", error);
        });
      }, WATCH_DEBOUNCE_MS);
      this.reloadTimer.unref?.();
    });
    this.watcher.on("error", (error) => {
      console.error("Failed to watch models config", error);
    });
  }

  async dispose(): Promise<void> {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    await this.refreshPromise;
  }

  private refresh(): Promise<void> {
    if (this.refreshPromise) {
      this.refreshAgain = true;
      return this.refreshPromise;
    }

    this.refreshPromise = this.runRefreshes().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async runRefreshes(): Promise<void> {
    do {
      this.refreshAgain = false;
      await this.modelRuntime.refresh({ allowNetwork: false });
      const error = this.modelRuntime.getError();
      if (error) {
        console.error("Models config reload reported an error", error);
      }
    } while (this.refreshAgain);
  }
}
