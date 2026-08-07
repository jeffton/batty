import { describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceSnapshot } from "@/shared/types";
import { registerWorkspaceRoutes } from "./workspaces";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("workspace event stream", () => {
  it("flushes headers before loading the initial snapshot", async () => {
    const app = { get: vi.fn(), post: vi.fn() };
    const snapshot = deferred<WorkspaceSnapshot>();
    registerWorkspaceRoutes(
      {
        app,
        config: {},
        service: {},
        cronService: {},
        routePath: (path: string) => path,
        workspaceSnapshot: vi.fn(() => snapshot.promise),
      } as never,
      new Map(),
    );

    const registration = app.get.mock.calls.find(
      ([path]) => path === "/api/workspaces/:workspaceId/events",
    );
    const handler = registration?.[1] as (request: unknown, reply: unknown) => Promise<void>;
    const writeHead = vi.fn();
    const flushHeaders = vi.fn();
    const write = vi.fn();
    const end = vi.fn();
    let closeHandler: (() => void) | undefined;

    const pending = handler(
      {
        params: { workspaceId: "batty" },
        raw: {
          on: (_event: string, callback: () => void) => {
            closeHandler = callback;
          },
        },
      },
      { raw: { writeHead, flushHeaders, write, end } },
    );

    expect(flushHeaders).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();

    snapshot.resolve({
      workspaceId: "batty",
      sessions: [],
      cronJobs: [],
      runningCronJobs: [],
      uiSettings: { easyMode: false },
    });
    await pending;
    expect(write).toHaveBeenCalledWith(
      'data: {"workspaceId":"batty","sessions":[],"cronJobs":[],"runningCronJobs":[],"uiSettings":{"easyMode":false}}\n\n',
    );

    closeHandler?.();
    expect(end).toHaveBeenCalledOnce();
  });
});
