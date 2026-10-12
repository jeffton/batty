// @vitest-environment node
import path from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright-core";
import type { ViteDevServer } from "vite";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

let browser: Browser;
let safari: Browser;
let server: ViteDevServer;
let url: string;
const evaluate = <T>(page: Page, fn: () => T) => page.evaluate(fn);
async function fixture(context = browser) {
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => Boolean((window as any).cache));
  return page;
}
beforeAll(async () => {
  server = await createBrowserFixtureServer("src/client/lib/MainCache.fixture.html", {
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/lib/MainCache.fixture.html`;
  browser = await chromium.launch({ headless: true });
  safari = await webkit.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await safari?.close();
  if (server) await closeBrowserFixtureServer(server);
});

test("native cache upserts IDs, rejects stale state, isolates users/workers and expires", async () => {
  const page = await fixture();
  const result = await evaluate(page, async () => {
    const c = (window as any).cache;
    const bootstrap = { authenticated: true, cacheScope: "a", cacheExpiresAt: Date.now() + 60_000 };
    const message = (id: string, text: string) => ({
      id,
      role: "user",
      timestamp: Date.now(),
      blocks: [{ type: "text", text }],
    });
    const session = {
      id: "1",
      sessionId: "1",
      streamId: "g",
      revision: 1,
      messages: [message("100", "old")],
      totalMessageCount: 1,
      activeTools: [],
    };
    await c.saveMainCache(bootstrap, c.reactive({ ...session, activeTools: [{ blocks: [] }] }));
    await c.saveMainCache(bootstrap, {
      ...session,
      revision: 3,
      messages: [message("100", "updated"), message("101", "new")],
    });
    await c.saveMainCache(bootstrap, { ...session, revision: 2 });
    const restored = await c.readMainCache();
    await c.saveMainCache(
      { ...bootstrap, cacheScope: "b" },
      { ...session, messages: [message("200", "other")] },
    );
    await c.saveMainCache(bootstrap, { ...session, isSubagentSession: true });
    const other = await c.readMainCache();
    const multi = Array.from({ length: 12 }, (_, i) => message(i ? `300:${i}` : "300", String(i)));
    await c.saveMainCache(bootstrap, { ...session, revision: 4, messages: multi });
    const ordered = await c.readMainCache();
    await c.clearMainCache();
    c.registerMainCacheBootstrap();
    await c.saveMainCache({ ...bootstrap, cacheExpiresAt: Date.now() - 1 }, session);
    return { restored, other, ordered, expired: await c.readMainCache() };
  });
  expect(result.restored.session.messages).toHaveLength(2);
  expect(result.restored.session.messages[0].blocks[0].text).toBe("updated");
  expect(result.restored.session.revision).toBe(3);
  expect(result.other.session.messages.map((m: any) => m.id)).toEqual(["200"]);
  expect(result.ordered.session.messages.map((m: any) => m.id)).toEqual([
    "300",
    ...Array.from({ length: 11 }, (_, i) => `300:${i + 1}`),
  ]);
  expect(result.expired).toBeUndefined();
  await page.close();
});

test("eviction protects 24h before optional history and has a hard bound", async () => {
  const page = await fixture();
  const result = await evaluate(page, () => {
    const c = (window as any).cache;
    const now = Date.now();
    const row = (id: number, hours: number, bytes: number) => ({
      id: String(id),
      timestamp: now - hours * 3_600_000,
      bytes,
      json: "{}",
    });
    return {
      optional: c
        .retainCacheRecords(
          [row(1, 200, 1), row(2, 48, c.CACHE_BYTE_BUDGET), row(3, 12, c.CACHE_BYTE_BUDGET)],
          now,
        )
        .map((r: any) => r.id),
      recent: c.retainCacheRecords(
        [row(4, 12, c.CACHE_BYTE_BUDGET), row(5, 1, c.CACHE_BYTE_BUDGET)],
        now,
      ).length,
      hard: (() => {
        try {
          c.retainCacheRecords(
            Array.from({ length: 5 }, (_, i) => row(i + 10, 1, c.CACHE_BYTE_BUDGET)),
            now,
          );
        } catch (error) {
          return String(error);
        }
      })(),
    };
  });
  expect(result.optional).toEqual(["3"]);
  expect(result.recent).toBe(2);
  expect(result.hard).toContain("128 MiB");
  await page.close();
});

test("logout in another tab cannot be undone by stale cache persistence", async () => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  for (const page of [first, second]) {
    await page.goto(url);
    await page.waitForFunction(() => Boolean((window as any).cache));
  }
  const seed = () =>
    (window as any).cache.saveMainCache(
      { cacheScope: "shared", cacheExpiresAt: Date.now() + 60_000 },
      {
        id: "1",
        sessionId: "1",
        messages: [
          {
            id: "1",
            role: "user",
            timestamp: Date.now(),
            blocks: [{ type: "text", text: "private" }],
          },
        ],
        activeTools: [],
      },
    );
  await evaluate(second, seed);
  await evaluate(first, () => (window as any).cache.clearMainCache());
  await evaluate(second, seed);
  expect(await evaluate(second, () => (window as any).cache.readMainCache())).toBeUndefined();
  await context.close();
});

test("cross-tab revision checks and commits are serialized", async () => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  for (const page of [first, second]) {
    await page.goto(url);
    await page.waitForFunction(() => Boolean((window as any).cache));
  }
  const revisionThree = () =>
    (window as any).cache.saveMainCache(
      { cacheScope: "same-user", cacheExpiresAt: Date.now() + 60_000 },
      {
        id: "1",
        sessionId: "1",
        streamId: "a",
        revision: 3,
        messages: [
          {
            id: "1",
            role: "user",
            timestamp: Date.now(),
            blocks: [{ type: "text", text: "newer" }],
          },
        ],
        activeTools: [],
      },
    );
  const revisionTwo = () =>
    (window as any).cache.saveMainCache(
      { cacheScope: "same-user", cacheExpiresAt: Date.now() + 60_000 },
      {
        id: "1",
        sessionId: "1",
        streamId: "a",
        revision: 2,
        messages: [
          {
            id: "1",
            role: "user",
            timestamp: Date.now(),
            blocks: [{ type: "text", text: "older" }],
          },
        ],
        activeTools: [],
      },
    );
  await Promise.all([evaluate(first, revisionThree), evaluate(second, revisionTwo)]);
  const restored = await evaluate(first, () => (window as any).cache.readMainCache());
  expect(restored.session.revision).toBe(3);
  expect(restored.session.messages[0].blocks[0].text).toBe("newer");
  await context.close();
});

test("quota error aborts the native transaction and keeps the previous complete cache", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => Boolean((window as any).cache));
  await evaluate(page, () =>
    (window as any).cache.saveMainCache(
      { cacheScope: "quota", cacheExpiresAt: Date.now() + 60_000 },
      {
        id: "1",
        sessionId: "1",
        revision: 1,
        streamId: "a",
        messages: [
          {
            id: "1",
            role: "user",
            timestamp: Date.now(),
            blocks: [{ type: "text", text: "retained" }],
          },
        ],
        activeTools: [],
      },
    ),
  );

  const result = await evaluate(page, async () => {
    const c = (window as any).cache;
    let error = "";
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (value.id === "2") throw new DOMException("Quota exceeded", "QuotaExceededError");
      return put.call(this, value, key);
    };
    try {
      const noise = Array.from({ length: 80_000 }, () => crypto.randomUUID()).join("");
      await c.saveMainCache(
        { cacheScope: "quota", cacheExpiresAt: Date.now() + 60_000 },
        {
          id: "1",
          sessionId: "1",
          revision: 2,
          streamId: "a",
          messages: [
            {
              id: "2",
              role: "user",
              timestamp: Date.now(),
              blocks: [{ type: "text", text: noise }],
            },
          ],
          activeTools: [],
        },
      );
    } catch (failure) {
      error = String(failure);
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    return { error, restored: await c.readMainCache() };
  });
  expect(result.error).toContain("Quota");
  expect(result.restored.session.messages[0].id).toBe("1");
  await context.close();
});

test.each(["Chromium", "WebKit"])(
  "%s cache survives suspension, closed connections, and a native read abort without unhandled rejections",
  async (engine) => {
    const context = await (engine === "WebKit" ? safari : browser).newContext();
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => Boolean((window as any).cache));
    const result = await evaluate(page, async () => {
      const c = (window as any).cache;
      const unhandled: string[] = [];
      window.addEventListener("unhandledrejection", (event) => {
        unhandled.push(String(event.reason));
      });
      let opens = 0;
      let connection: IDBDatabase;
      const nativeOpen = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (...args) {
        opens += 1;
        const operation = nativeOpen.apply(this, args);
        operation.addEventListener("success", () => {
          connection = operation.result;
        });
        return operation;
      };
      const bootstrap = { cacheScope: "lifecycle", cacheExpiresAt: Date.now() + 60_000 };
      const session = {
        id: "1",
        sessionId: "1",
        streamId: "a",
        revision: 1,
        activeTools: [],
        messages: [{ id: "1", role: "user", timestamp: Date.now(), blocks: [] }],
      };
      await c.saveMainCache(bootstrap, session);
      const suspendedConnection = connection!;
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      await Promise.resolve();
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      await c.saveMainCache(bootstrap, { ...session, revision: 2 });
      suspendedConnection.dispatchEvent(new Event("close"));
      const afterResume = await c.readMainCache();
      // A storage process termination closes the connection without pagehide.
      connection!.close();
      connection!.dispatchEvent(new Event("close"));
      await c.saveMainCache(bootstrap, { ...session, revision: 3 });
      const getAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function (...args) {
        const operation = getAll.apply(this, args);
        this.transaction.abort();
        return operation;
      };
      let abort = "";
      try {
        await c.readMainCache();
      } catch (error) {
        abort = String(error);
      } finally {
        IDBObjectStore.prototype.getAll = getAll;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      const retained = await c.readMainCache();
      // Suspend during the read half of a save, not just between finished saves.
      IDBObjectStore.prototype.getAll = function (...args) {
        const operation = getAll.apply(this, args);
        operation.addEventListener(
          "success",
          () => {
            window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
          },
          { once: true },
        );
        IDBObjectStore.prototype.getAll = getAll;
        return operation;
      };
      const cancellation = await c
        .saveMainCache(bootstrap, { ...session, revision: 4 })
        .catch((error: Error) => error instanceof c.CacheSuspendedError);
      if (!cancellation) throw new Error("Expected owned suspension cancellation");
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      await c.saveMainCache(bootstrap, { ...session, revision: 4 });
      const afterOverlappingSuspension = await c.readMainCache();
      IDBFactory.prototype.open = nativeOpen;
      return { opens, afterResume, retained, afterOverlappingSuspension, abort, unhandled };
    });
    expect(result.opens).toBe(5);
    expect(result.afterOverlappingSuspension.session.revision).toBe(4);
    expect(result.afterResume.session.revision).toBe(2);
    expect(result.retained.session.revision).toBe(3);
    expect(result.abort).toMatch(/abort/i);
    expect(result.unhandled).toEqual([]);
    await context.setOffline(true);
    expect(await evaluate(page, () => (window as any).cache.readMainCache())).toMatchObject({
      session: { revision: 4 },
    });
    await context.setOffline(false);
    await page.reload();
    await page.waitForFunction(() => Boolean((window as any).cache));
    expect(await evaluate(page, () => (window as any).cache.readMainCache())).toMatchObject({
      session: { revision: 4 },
    });
    await context.close();
  },
);

test.each(["Chromium", "WebKit"])(
  "%s failed save joins the read abort and releases the poisoned connection",
  async (engine) => {
    const page = await fixture(engine === "WebKit" ? safari : browser);
    const result = await evaluate(page, async () => {
      const c = (window as any).cache;
      const bootstrap = { cacheScope: "failure", cacheExpiresAt: Date.now() + 60_000 };
      const session = {
        id: "1",
        sessionId: "1",
        streamId: "a",
        revision: 1,
        messages: [],
        activeTools: [],
      };
      await c.saveMainCache(bootstrap, session);
      let terminal = false;
      let premature = false;
      let opens = 0;
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (...args) {
        opens += 1;
        return open.apply(this, args);
      };
      const nativeTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const transaction = nativeTransaction.apply(this, args);
        transaction.addEventListener("abort", () => {
          terminal = true;
        });
        return transaction;
      };
      const getAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function (...args) {
        IDBObjectStore.prototype.getAll = getAll;
        const operation = getAll.apply(this, args);
        const transaction = this.transaction;
        // Model the native request failing before its transaction's abort task.
        queueMicrotask(() => {
          Object.defineProperty(operation, "error", {
            value: new DOMException(
              "Attempt to get a record from database without an in-progress transaction",
              "UnknownError",
            ),
          });
          operation.onerror!(new Event("error"));
          transaction.abort();
        });
        return operation;
      };
      const failed = c
        .saveMainCache(bootstrap, { ...session, revision: 2 })
        .catch((error: Error) => {
          premature = !terminal;
          return { name: error.name, message: error.message, stack: error.stack };
        });
      // Already queued saves must wait for the terminal event and use a new connection.
      const next = c.saveMainCache(bootstrap, { ...session, revision: 3 });
      const error = await failed;
      await next;
      const restored = await c.readMainCache();
      IDBFactory.prototype.open = open;
      IDBDatabase.prototype.transaction = nativeTransaction;
      return { premature, terminal, opens, error, revision: restored.session.revision };
    });
    expect(result.premature).toBe(false);
    expect(result.opens).toBe(1);
    expect(result.revision).toBe(3);
    expect(result.error.name).toBe("UnknownError");
    expect(result.error.stack).toContain("main-cache.ts");
    await page.close();
  },
);

test.each(["Chromium", "WebKit"])(
  "%s cancels owned suspension work, preserves prior cache and resumes fresh writes",
  async (engine) => {
    const page = await fixture(engine === "WebKit" ? safari : browser);
    const result = await evaluate(page, async () => {
      const c = (window as any).cache;
      const bootstrap = { cacheScope: "suspension", cacheExpiresAt: Date.now() + 60_000 };
      const session = {
        id: "1",
        sessionId: "1",
        streamId: "a",
        revision: 1,
        messages: [
          {
            id: "1",
            timestamp: Date.now(),
            role: "user",
            blocks: [{ type: "text", text: "offline original" }],
          },
        ],
      };
      await c.saveMainCache(bootstrap, session);
      let hidden = false;
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (hidden ? "hidden" : "visible"),
      });
      const hide = () => {
        hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
      };
      const resume = () => {
        hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
      };
      const commit = IDBTransaction.prototype.commit;
      IDBTransaction.prototype.commit = function () {
        IDBTransaction.prototype.commit = commit;
        // Keep this transaction uncommitted until its request success task.
      };
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        const operation = put.apply(this, args);
        if (this.name === "metadata") {
          IDBObjectStore.prototype.put = put;
          // Control event timing with a real native write; not phone suspension.
          operation.addEventListener("success", hide, { once: true });
        }
        return operation;
      };
      const writeError = await c
        .saveMainCache(bootstrap, { ...session, revision: 2 })
        .catch((error: Error) => ({
          owned: error instanceof c.CacheSuspendedError,
          message: error.message,
        }));
      const hiddenRead = await c
        .readMainCache()
        .catch((error: Error) => error instanceof c.CacheSuspendedError);
      resume();
      const previous = await c.readMainCache();
      const getAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function (...args) {
        IDBObjectStore.prototype.getAll = getAll;
        const operation = getAll.apply(this, args);
        operation.addEventListener("success", hide, { once: true });
        return operation;
      };
      // Resume when the cancelled read settles. WebKit may defer lock grants
      // while hidden; queued saves must not be mistaken for deadlocked writes.
      const overlapping = await Promise.allSettled([
        c.readMainCache().catch((error: Error) => {
          resume();
          throw error;
        }),
        c.saveMainCache(bootstrap, { ...session, revision: 3 }),
        c.saveMainCache(bootstrap, { ...session, revision: 4 }),
      ]);
      await c.saveMainCache(bootstrap, {
        ...session,
        revision: 5,
        messages: [
          ...session.messages,
          { ...session.messages[0], id: "2", blocks: [{ type: "text", text: "fresh foreground" }] },
        ],
      });
      const fresh = await c.readMainCache();
      return {
        writeError,
        hiddenRead,
        previous: previous.session.revision,
        cancellations: overlapping.map(
          (r) => r.status === "rejected" && r.reason instanceof c.CacheSuspendedError,
        ),
        freshRevision: fresh.session.revision,
        texts: fresh.session.messages.map((m: any) => m.blocks[0].text),
      };
    });
    expect(result.writeError.owned).toBe(true);
    expect(result.hiddenRead).toBe(true);
    expect(result.previous).toBe(1);
    expect(result.cancellations[0]).toBe(true);
    expect(result.freshRevision).toBe(5);
    expect(result.texts).toEqual(["offline original", "fresh foreground"]);
    await page.close();
  },
);

test.each(["Chromium", "WebKit"])(
  "%s waits for every overlapping abort and preserves a write already committed on hide",
  async (engine) => {
    const page = await fixture(engine === "WebKit" ? safari : browser);
    const result = await evaluate(page, async () => {
      const c = (window as any).cache;
      const bootstrap = { cacheScope: "terminal", cacheExpiresAt: Date.now() + 60_000 };
      const session = {
        id: "1",
        sessionId: "1",
        streamId: "a",
        revision: 1,
        messages: [{ id: "1", timestamp: Date.now(), role: "user", blocks: [] }],
      };
      await c.saveMainCache(bootstrap, session);
      let hidden = false;
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (hidden ? "hidden" : "visible"),
      });
      const hide = () => {
        hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
      };
      const resume = () => {
        hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
      };
      const pending = new Map<IDBDatabase, number>();
      let prematureClose = false;
      let mostPending = 0;
      const nativeTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args: any[]) {
        const transaction = nativeTransaction.apply(this, args as any);
        pending.set(this, (pending.get(this) ?? 0) + 1);
        mostPending = Math.max(mostPending, pending.get(this)!);
        const settled = () => pending.set(this, pending.get(this)! - 1);
        transaction.addEventListener("complete", settled);
        transaction.addEventListener("abort", settled);
        return transaction;
      };
      const close = IDBDatabase.prototype.close;
      IDBDatabase.prototype.close = function () {
        if ((pending.get(this) ?? 0) > 0) prematureClose = true;
        close.call(this);
      };
      const getAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function (...args) {
        IDBObjectStore.prototype.getAll = getAll;
        const operation = getAll.apply(this, args);
        operation.addEventListener("success", hide, { once: true });
        return operation;
      };
      const reads = await Promise.allSettled([c.readMainCache(), c.readMainCache()]);
      resume();
      const commit = IDBTransaction.prototype.commit;
      IDBTransaction.prototype.commit = function () {
        IDBTransaction.prototype.commit = commit;
        commit.call(this);
        // abort() must throw InvalidStateError here, not cancel a committed write.
        hide();
      };
      await c.saveMainCache(bootstrap, { ...session, revision: 2 });
      resume();
      const cached = await c.readMainCache();
      IDBDatabase.prototype.transaction = nativeTransaction;
      IDBDatabase.prototype.close = close;
      return {
        prematureClose,
        mostPending,
        revision: cached.session.revision,
        cancelled: reads.map(
          (r) => r.status === "rejected" && r.reason instanceof c.CacheSuspendedError,
        ),
      };
    });
    expect(result.prematureClose).toBe(false);
    expect(result.mostPending).toBe(2);
    expect(result.cancelled).toEqual([true, true]);
    expect(result.revision).toBe(2);
    await page.close();
  },
);

test.each(["Chromium", "WebKit"])(
  "%s resumes without pagehide and rejects an open revoked before success",
  async (engine) => {
    const page = await fixture(engine === "WebKit" ? safari : browser);
    const result = await evaluate(page, async () => {
      const c = (window as any).cache;
      const bootstrap = { cacheScope: "visibility", cacheExpiresAt: Date.now() + 60_000 };
      const session = {
        id: "1",
        sessionId: "1",
        streamId: "a",
        revision: 1,
        messages: [
          {
            id: "1",
            role: "user",
            timestamp: Date.now(),
            blocks: [{ type: "text", text: "retained across suspension" }],
          },
        ],
        activeTools: [],
      };
      const nativeOpen = IDBFactory.prototype.open;
      let connection: IDBDatabase | undefined;
      let opens = 0;
      let revokeOnSuccess = false;
      IDBFactory.prototype.open = function (...args) {
        opens += 1;
        const operation = nativeOpen.apply(this, args);
        operation.addEventListener("success", () => {
          connection = operation.result;
          if (revokeOnSuccess) {
            revokeOnSuccess = false;
            document.dispatchEvent(new Event("visibilitychange"));
          }
        });
        return operation;
      };
      await c.saveMainCache(bootstrap, session);
      const stale = connection!;
      // Model storage-process eviction with no close/pagehide event. Reusing
      // this real, closed connection would fail at transaction creation.
      stale.close();
      document.dispatchEvent(new Event("visibilitychange"));
      revokeOnSuccess = true;
      await c.saveMainCache(bootstrap, { ...session, revision: 2 });
      const restored = await c.readMainCache();
      const opensAfterResume = opens;
      // A delayed close event from the old owner must not evict its replacement.
      stale.dispatchEvent(new Event("close"));
      await c.saveMainCache(bootstrap, { ...session, revision: 3 });
      const final = await c.readMainCache();
      IDBFactory.prototype.open = nativeOpen;
      return {
        opensAfterResume,
        opens,
        revision: restored.session.revision,
        finalRevision: final.session.revision,
        text: final.session.messages[0].blocks[0].text,
      };
    });
    expect(result).toEqual({
      opensAfterResume: 3,
      opens: 3,
      revision: 2,
      finalRevision: 3,
      text: "retained across suspension",
    });
    await page.close();
  },
);
