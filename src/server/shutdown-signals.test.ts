import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";
import { installShutdownSignals } from "./shutdown-signals";

describe("checkpoint shutdown signals", () => {
  it("checkpoints once before exiting on service-manager signals", async () => {
    const host = new EventEmitter();
    let release!: () => void;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const finished = vi.fn();
    const remove = installShutdownSignals(shutdown, host as unknown as NodeJS.Process, finished);
    host.emit("SIGTERM");
    host.emit("SIGINT");
    expect(shutdown).toHaveBeenCalledOnce();
    expect(finished).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(0));
    remove();
    expect(host.listenerCount("SIGTERM")).toBe(0);
  });
});
