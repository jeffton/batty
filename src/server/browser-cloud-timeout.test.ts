// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import { removeTestBrowserRoot } from "./test-browser-cleanup";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { Browser, CDPSession, Page } from "patchright";
import fastify from "fastify";
import { BrowserService } from "./browser-service";
import { registerCloudBrowserRoutes } from "./routes/cloud-browser";
import { browserSessionDirectory } from "./browser-persistence";
import * as webauthn from "./browser-webauthn";
import { CloudBrowserStreams } from "./cloud-browser-stream";

function controlCloudDeadlines() {
  const original = globalThis.setTimeout;
  const deadlines: (() => void)[] = [];
  const timer = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((callback, delay, ...args) => {
      if (delay !== 15_000) return original(callback, delay, ...args);
      // Chromium and cleanup keep real timers; only the operation deadline is held.
      const handle = original(() => {}, delay);
      deadlines.push(() => {
        clearTimeout(handle);
        callback(...args);
      });
      return handle;
    });
  return {
    expireNext() {
      expect(deadlines.length).toBeGreaterThan(0);
      deadlines.shift()!();
    },
    restore: () => timer.mockRestore(),
  };
}

test.each([false, true])(
  "lost touch acknowledgement releases state/WS and permits a fresh session (cleanup failure: %s)",
  async (cleanupFailure) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-cloud-timeout-"));
    const website = http.createServer((_, response) => response.end("<title>Ready</title>Ready"));
    website.listen(0, "127.0.0.1");
    await once(website, "listening");
    const url = `http://127.0.0.1:${(website.address() as { port: number }).port}/`;
    const service = new BrowserService(undefined, 4, root);
    const app = fastify();
    const closeRoutes = await registerCloudBrowserRoutes(app, service, "https://batty.example");
    await app.ready();
    const internals = service as unknown as {
      sessions: Map<
        string,
        { browser: Browser; pages: Map<string, Page>; pageEmulation: WeakMap<Page, CDPSession> }
      >;
      queues: Map<string, Promise<void>>;
      cloudTouches: Map<string, unknown>;
      serialized<T>(id: string, operation: () => Promise<T>): Promise<T>;
    };
    let acknowledge!: () => void;
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    const lostReply = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    try {
      const opened = await service.execute("worker", { action: "open", url, cloud: true });
      const id = opened.details.sites![0]!.browserId;
      const state = await service.cloudState(id);
      const session = internals.sessions.get("worker")!;
      const connection = session.pageEmulation.get(session.pages.values().next().value!)!;
      const originalSend = connection.send.bind(connection);
      vi.spyOn(connection, "send").mockImplementation((async (method: string, parameters: any) => {
        if (method === "Input.dispatchTouchEvent" && parameters.type === "touchStart") {
          started();
          return lostReply;
        }
        return originalSend(method as any, parameters);
      }) as typeof connection.send);
      const pid = JSON.parse(
        await fs.readFile(
          path.join(browserSessionDirectory(root, "worker"), "process.json"),
          "utf8",
        ),
      ).pid;
      if (cleanupFailure)
        vi.spyOn(session.browser, "close").mockRejectedValue(new Error("CDP detach failed"));
      const deadline = controlCloudDeadlines();
      const touch = service.cloudTouch(
        id,
        {
          action: "touch",
          phase: "start",
          pageId: state.pageId,
          revision: state.revision,
          x: 100,
          y: 100,
          elapsedMs: 0,
        },
        "viewer",
      );
      const failure = touch.catch((error: Error & { statusCode: number }) => error);
      const timedOut = expect(failure).resolves.toMatchObject({
        statusCode: 504,
        message: expect.stringContaining(
          cleanupFailure ? "cleanup failed" : "Cloud browser operation timed out",
        ),
      });
      await dispatched;
      // Both routes used to queue forever behind the same unacknowledged CDP send.
      const admission = vi.spyOn(internals, "serialized");
      const pendingState = app.inject({ url: `/api/cloud-browser/${id}/state` });
      const pendingSocket = app.injectWS(`/api/cloud-browser/${id}/socket`, {
        headers: { origin: "https://batty.example" },
      });
      const rejectedSocket = expect(pendingSocket).rejects.toThrow(/410|504/);
      await vi.waitFor(() => expect(admission).toHaveBeenCalledTimes(2));
      admission.mockRestore();
      deadline.expireNext();
      deadline.restore();
      await timedOut;
      const stateResponse = await pendingState;
      await rejectedSocket;
      // Queue admission can hit its own deadline while process cleanup finishes.
      expect([410, 504]).toContain(stateResponse.statusCode);
      expect(stateResponse.json().message ?? stateResponse.json().error).toMatch(
        /timed out|session ended/,
      );
      expect(() => process.kill(pid, 0)).toThrow("ESRCH");
      expect(internals.queues.has("worker")).toBe(false);
      expect(internals.cloudTouches.size).toBe(0);
      expect(await service.hasSession("worker")).toBe(false);
      const fresh = await service.execute("worker", { action: "open", url, cloud: true });
      const nextId = fresh.details.sites![0]!.browserId;
      expect(nextId).not.toBe(id);
      expect((await service.cloudState(nextId)).title).toBe("Ready");
      if (cleanupFailure) {
        const error = await failure;
        const stateFailure = vi.spyOn(service, "cloudState").mockRejectedValueOnce(error);
        expect((await app.inject({ url: `/api/cloud-browser/${nextId}/state` })).statusCode).toBe(
          504,
        );
        stateFailure.mockRestore();
        const subscribe = vi
          .spyOn(CloudBrowserStreams.prototype, "subscribe")
          .mockRejectedValueOnce(error);
        let receive!: (message: Buffer) => void;
        const notification = new Promise<Buffer>((resolve) => {
          receive = resolve;
        });
        const socket = await app.injectWS(
          `/api/cloud-browser/${nextId}/socket`,
          { headers: { origin: "https://batty.example" } },
          {
            onInit: (socket) => {
              socket.once("message", receive);
            },
          },
        );
        const message = await notification;
        expect(JSON.parse(message.toString())).toMatchObject({
          event: "browser-error",
          data: { statusCode: 504, retryable: false },
        });
        socket.close();
        subscribe.mockRestore();
      }
      // A late protocol response cannot restore/touch the abandoned session.
      acknowledge();
      await new Promise((resolve) => setImmediate(resolve));
      expect((await service.cloudState(nextId)).title).toBe("Ready");
    } finally {
      acknowledge();
      vi.restoreAllMocks();
      await closeRoutes();
      await app.close();
      await service.closeSession("worker");
      await service.dispose();
      website.closeAllConnections();
      await new Promise<void>((resolve) => website.close(() => resolve()));
      await removeTestBrowserRoot(root);
    }
  },
  35_000,
);

test("cloud queue deadlines leave an active predecessor intact, and reconnect startup is cancellable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-cloud-reconnect-"));
  const website = http.createServer((_, response) => response.end("<title>Ready</title>Ready"));
  website.listen(0, "127.0.0.1");
  await once(website, "listening");
  const url = `http://127.0.0.1:${(website.address() as { port: number }).port}/`;
  let service = new BrowserService(undefined, 4, root);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const opened = await service.execute("worker", { action: "open", url, cloud: true });
    const id = opened.details.sites![0]!.browserId;
    const internals = service as unknown as {
      serialized<T>(id: string, operation: () => Promise<T>): Promise<T>;
      startups: Map<string, unknown>;
      queues: Map<string, unknown>;
    };
    const predecessor = internals.serialized("worker", () => barrier);
    const queueDeadline = controlCloudDeadlines();
    const admission = vi.spyOn(internals, "serialized");
    const queued = expect(service.cloudState(id)).rejects.toMatchObject({
      statusCode: 504,
      message: expect.stringContaining("queue timed out"),
    });
    await vi.waitFor(() => expect(admission).toHaveBeenCalledOnce());
    admission.mockRestore();
    queueDeadline.expireNext();
    queueDeadline.restore();
    await queued;
    expect(await service.hasSession("worker")).toBe(true);
    release();
    await predecessor;
    expect((await service.cloudState(id)).title).toBe("Ready");
    await service.dispose();
    service = new BrowserService(undefined, 4, root);
    let entered!: () => void;
    const reconnecting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // Reconnect has non-Playwright-timeout stages too, such as installing the
    // capability policy into existing frames. Simulate a missing CDP response.
    const policy = vi.spyOn(webauthn, "installWebAuthnPolicy").mockImplementation(() => {
      entered();
      return new Promise(() => {});
    });
    const reconnectDeadline = controlCloudDeadlines();
    const pending = service.cloudState(id);
    const timeout = expect(pending).rejects.toMatchObject({ statusCode: 504 });
    await reconnecting;
    reconnectDeadline.expireNext();
    reconnectDeadline.restore();
    await timeout;
    policy.mockRestore();
    const after = service as unknown as typeof internals;
    expect(after.startups.size).toBe(0);
    expect(after.queues.size).toBe(0);
    expect(await service.hasSession("worker")).toBe(false);
    const fresh = await service.execute("worker", { action: "open", url, cloud: true });
    expect((await service.cloudState(fresh.details.sites![0]!.browserId)).title).toBe("Ready");
  } finally {
    release();
    vi.restoreAllMocks();
    await service.closeSession("worker");
    await service.dispose();
    website.closeAllConnections();
    await new Promise<void>((resolve) => website.close(() => resolve()));
    await removeTestBrowserRoot(root);
  }
}, 45_000);
