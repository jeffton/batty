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

test.each(["Chromium", "WebKit"])(
  "%s quota error aborts atomically and keeps the previous cache",
  async (engine) => {
    const context = await (engine === "WebKit" ? safari : browser).newContext();
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
        if (value.order?.[1] === 2) throw new DOMException("Quota exceeded", "QuotaExceededError");
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
  },
);

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
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (...args) {
        const operation = get.apply(this, args);
        this.transaction.abort();
        return operation;
      };
      let abort = "";
      try {
        await c.readMainCache();
      } catch (error) {
        abort = String(error);
      } finally {
        IDBObjectStore.prototype.get = get;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      const retained = await c.readMainCache();
      // Suspend during the read half of a save, not just between finished saves.
      IDBObjectStore.prototype.get = function (...args) {
        const operation = get.apply(this, args);
        operation.addEventListener(
          "success",
          () => {
            window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
          },
          { once: true },
        );
        IDBObjectStore.prototype.get = get;
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
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (...args) {
        IDBObjectStore.prototype.get = get;
        const operation = get.apply(this, args);
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
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (...args) {
        IDBObjectStore.prototype.get = get;
        const operation = get.apply(this, args);
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
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (...args) {
        IDBObjectStore.prototype.get = get;
        const operation = get.apply(this, args);
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

test.each(["Chromium", "WebKit"])(
  "%s pages numeric IDs, stops at holes, and joins only certified adjacent pages",
  async (engine) => {
    const page = await fixture(engine === "WebKit" ? safari : browser);
    const result = await evaluate(page, async () => {
      const c = (window as any).cache;
      const bootstrap = { cacheScope: "ranges", cacheExpiresAt: Date.now() + 60_000 };
      const message = (id: string) => ({ id, timestamp: Date.now(), role: "user", blocks: [] });
      const tail = Array.from({ length: 12 }, (_, i) => message(i ? `100:${i}` : "100"));
      const session = {
        id: "1",
        streamId: "a",
        revision: 1,
        messages: tail,
        totalMessageCount: 14,
        hasMoreMessages: true,
        activeTools: [],
      };
      // Any accidental unbounded history read fails, even with a tiny fixture.
      const getAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = () => {
        throw new Error("Unbounded read");
      };
      await c.saveMainCache(bootstrap, session);
      const newest = await c.readMainCachePage({ sessionId: "1", limit: 3 });
      const older = await c.readMainCachePage({ sessionId: "1", before: "100:9", limit: 20 });
      await c.saveMainCache(bootstrap, session, [message("1")], { hasMoreMessages: false });
      const gap = await c.readMainCachePage({ sessionId: "1", before: "100" });
      const head = await c.readMainCache();
      await c.saveMainCache(bootstrap, session, [message("50")], {
        before: "100",
        hasMoreMessages: true,
      });
      const bridged = await c.readMainCachePage({ sessionId: "1", before: "100" });
      const remainingGap = await c.readMainCachePage({ sessionId: "1", before: "50" });
      await c.saveMainCache(bootstrap, session, [message("1")], {
        before: "50",
        hasMoreMessages: false,
      });
      const complete = await c.readMainCachePage({ sessionId: "1", before: "100", limit: 50 });
      const wrongSession = await c.readMainCachePage({ sessionId: "2", before: "100" });
      IDBObjectStore.prototype.getAll = getAll;
      return { newest, older, gap, head, bridged, remainingGap, complete, wrongSession };
    });
    expect(result.newest.messages.map((m: any) => m.id)).toEqual(["100:9", "100:10", "100:11"]);
    expect(result.older.messages.map((m: any) => m.id)).toEqual([
      "100",
      ...Array.from({ length: 8 }, (_, i) => `100:${i + 1}`),
    ]);
    expect(result.gap).toBeUndefined();
    expect(result.head.session.messages.at(-1).id).toBe("100:11");
    expect(result.bridged.messages.map((m: any) => m.id)).toEqual(["50"]);
    expect(result.bridged.hasMoreMessages).toBe(true);
    expect(result.remainingGap).toBeUndefined();
    expect(result.complete.messages.map((m: any) => m.id)).toEqual(["1", "50"]);
    expect(result.complete.hasMoreMessages).toBe(false);
    expect(result.wrongSession).toBeUndefined();
    await page.close();
  },
);

test.each(["Chromium", "WebKit"])(
  "%s migrates v1 history in place without clearing rows and keeps numeric suffix order",
  async (engine) => {
    const page = await fixture(engine === "WebKit" ? safari : browser);
    const result = await evaluate(page, async () => {
      const now = Date.now();
      const bootstrap = { cacheScope: "legacy", cacheExpiresAt: now + 60_000 };
      const messages = Array.from({ length: 12 }, (_, i) => ({
        id: i ? `100:${i}` : "100",
        timestamp: now,
        role: "user",
        blocks: [],
      }));
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const operation = indexedDB.open("batty-main-reading-v1", 1);
        operation.onupgradeneeded = () => {
          operation.result.createObjectStore("metadata");
          operation.result.createObjectStore("messages", { keyPath: "id" });
        };
        operation.onsuccess = () => resolve(operation.result);
        operation.onerror = () => reject(operation.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["messages", "metadata"], "readwrite");
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
        tx.objectStore("metadata").put(
          {
            epoch: null,
            bootstrap,
            savedAt: now,
            session: { id: "1", streamId: "a", revision: 1, messages: [], totalMessageCount: 12 },
          },
          "current",
        );
        for (const message of messages) {
          const json = JSON.stringify(message);
          tx.objectStore("messages").put({
            id: message.id,
            timestamp: now,
            json,
            bytes: new TextEncoder().encode(json).length,
          });
        }
      });
      db.close();
      const c = (window as any).cache;
      const restored = await c.readMainCache();
      // An upsert of a migrated row must not duplicate its legacy primary key.
      await c.saveMainCache(bootstrap, {
        ...restored.session,
        revision: 2,
        messages: [{ ...messages[11], blocks: [{ type: "text", text: "updated" }] }],
      });
      const connection = await new Promise<IDBDatabase>((resolve) => {
        const op = indexedDB.open("batty-main-reading-v1", 2);
        op.onsuccess = () => resolve(op.result);
      });
      const count = await new Promise<number>((resolve) => {
        const operation = connection.transaction("messages").objectStore("messages").count();
        operation.onsuccess = () => resolve(operation.result);
      });
      connection.close();
      const final = await c.readMainCache();
      return { restored, final, count };
    });
    expect(result.restored.session.messages.map((m: any) => m.id)).toEqual([
      "100",
      ...Array.from({ length: 11 }, (_, i) => `100:${i + 1}`),
    ]);
    expect(result.restored.session.hasMoreMessages).toBe(false);
    expect(result.count).toBe(12);
    expect(result.final.session.messages.at(-1).blocks[0].text).toBe("updated");
    await page.close();
  },
);

test.each(["Chromium", "WebKit"])(
  "%s incrementally stores and browses a real 144 MiB day without getAll or eviction",
  async (engine) => {
    const page = await fixture(engine === "WebKit" ? safari : browser);
    const result = await evaluate(page, async () => {
      const c = (window as any).cache;
      const bootstrap = { cacheScope: "large", cacheExpiresAt: Date.now() + 180_000 };
      const session = {
        id: "1",
        streamId: "a",
        revision: 1,
        messages: [],
        totalMessageCount: 144,
        hasMoreMessages: true,
        activeTools: [],
      };
      const getAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = () => {
        throw new Error("Unbounded read");
      };
      for (let end = 144; end > 0; end -= 12) {
        const messages = Array.from({ length: 12 }, (_, i) => ({
          id: String(end - 11 + i),
          role: "user",
          timestamp: Date.now(),
          blocks: [{ type: "text", text: String(end - 11 + i) + "x".repeat(1024 * 1024) }],
        }));
        await c.saveMainCache(bootstrap, session, messages, {
          before: end === 144 ? undefined : String(end + 1),
          hasMoreMessages: end > 12,
        });
      }
      const head = await c.readMainCache();
      const ids: string[] = [];
      let cursor: string | undefined;
      let bytes = 0;
      for (;;) {
        const page = await c.readMainCachePage({ sessionId: "1", before: cursor });
        if (!page) throw new Error("Unexpected hole");
        if (page.messages.length !== 1)
          throw new Error("Oversized messages must page individually");
        const message = page.messages[0];
        ids.push(message.id);
        bytes += message.blocks[0].text.length;
        if (!page.hasMoreMessages) break;
        cursor = message.id;
      }
      // Small live-window updates retain all previously synchronized history.
      await c.saveMainCache(bootstrap, { ...session, revision: 2 }, [
        { id: "144", role: "user", timestamp: Date.now(), blocks: [] },
      ]);
      const oldest = await c.readMainCachePage({ sessionId: "1", before: "2" });
      IDBObjectStore.prototype.getAll = getAll;
      return {
        count: head.session.messages.length,
        newest: head.session.messages[0].id,
        hasMore: head.session.hasMoreMessages,
        ids,
        bytes,
        oldest: oldest.messages[0].id,
      };
    });
    expect(result.count).toBe(1);
    expect(result.newest).toBe("144");
    expect(result.hasMore).toBe(true);
    expect(result.ids).toEqual(Array.from({ length: 144 }, (_, i) => String(144 - i)));
    expect(result.bytes).toBeGreaterThan(128 * 1024 * 1024);
    expect(result.oldest).toBe("1");
    await page.close();
  },
  120_000,
);
