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

function snapshot(workspaceId: string, revision = 1): WorkspaceSnapshot {
  return {
    workspaceId,
    revision,
    sessions: [],
    cronJobs: [],
    runningCronJobs: [],
    cronRunLogs: [],
    uiSettings: { easyMode: false },
  };
}

describe("workspace event stream", () => {
  it("flushes headers and sends all workspace updates over one connection", async () => {
    const app = { get: vi.fn(), post: vi.fn() };
    const initialSnapshots = deferred<WorkspaceSnapshot[]>();
    const subscribers = new Set<(snapshot: WorkspaceSnapshot) => void>();
    registerWorkspaceRoutes(
      {
        app,
        config: {},
        service: {},
        cronService: {},
        routePath: (path: string) => path,
        workspaceSnapshots: vi.fn(() => initialSnapshots.promise),
      } as never,
      subscribers,
    );

    const registration = app.get.mock.calls.find(([path]) => path === "/api/workspaces/events");
    const handler = registration?.[1] as (request: unknown, reply: unknown) => Promise<void>;
    const writeHead = vi.fn();
    const flushHeaders = vi.fn();
    const write = vi.fn();
    const end = vi.fn();
    let closeHandler: (() => void) | undefined;

    const pending = handler(
      {
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
    expect(subscribers.size).toBe(1);

    const pendingBatty = { ...snapshot("batty", 3), isInProgress: true };
    subscribers.values().next().value?.(pendingBatty);
    subscribers.values().next().value?.(snapshot("batty", 2));
    initialSnapshots.resolve([snapshot("batty"), snapshot("other")]);
    await pending;
    expect(write).toHaveBeenCalledWith(`data: ${JSON.stringify(snapshot("batty"))}\n\n`);
    expect(write).toHaveBeenCalledWith(`data: ${JSON.stringify(snapshot("other"))}\n\n`);
    expect(write).toHaveBeenLastCalledWith(`data: ${JSON.stringify(pendingBatty)}\n\n`);

    subscribers.values().next().value?.(snapshot("third"));
    expect(write).toHaveBeenLastCalledWith(`data: ${JSON.stringify(snapshot("third"))}\n\n`);

    closeHandler?.();
    expect(subscribers.size).toBe(0);
    expect(end).toHaveBeenCalledOnce();
  });

  it("cleans up when initial snapshots fail", async () => {
    const app = { get: vi.fn(), post: vi.fn() };
    const subscribers = new Set<(snapshot: WorkspaceSnapshot) => void>();
    registerWorkspaceRoutes(
      {
        app,
        config: {},
        service: {},
        cronService: {},
        routePath: (path: string) => path,
        workspaceSnapshots: vi.fn(async () => {
          throw new Error("snapshot failed");
        }),
      } as never,
      subscribers,
    );

    const registration = app.get.mock.calls.find(([path]) => path === "/api/workspaces/events");
    const handler = registration?.[1] as (request: unknown, reply: unknown) => Promise<void>;
    const end = vi.fn();

    await expect(
      handler(
        { raw: { on: vi.fn() } },
        {
          raw: {
            writeHead: vi.fn(),
            flushHeaders: vi.fn(),
            write: vi.fn(),
            end,
          },
        },
      ),
    ).rejects.toThrow("snapshot failed");

    expect(subscribers.size).toBe(0);
    expect(end).toHaveBeenCalledOnce();
  });
});
