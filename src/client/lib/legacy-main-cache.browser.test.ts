// @vitest-environment node
import path from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright-core";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

let browsers: Browser[];
let server: ViteDevServer;
let url: string;
beforeAll(async () => {
  server = await createBrowserFixtureServer("src/client/lib/MainCache.fixture.html", {
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/lib/MainCache.fixture.html`;
  browsers = await Promise.all([
    chromium.launch({ headless: true }),
    webkit.launch({ headless: true }),
  ]);
}, 30_000);
afterAll(async () => {
  await Promise.all(browsers.map((browser) => browser.close()));
  await closeBrowserFixtureServer(server);
});
async function fixture(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(url);
  await page.addScriptTag({
    type: "module",
    content: `
    import * as migration from '/src/client/lib/legacy-main-cache.ts';
    import * as storage from '/src/client/lib/installation-storage.ts';
    window.legacyModules = { migration, storage };
  `,
  });
  await page.waitForFunction(() => Boolean((window as any).legacyModules));
  await page.evaluate(async () => {
    const { migration, storage } = (window as any).legacyModules;
    const done = (tx: IDBTransaction) =>
      new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    const open = (name: string, version?: number) =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const operation = version ? indexedDB.open(name, version) : indexedDB.open(name);
        operation.onupgradeneeded = () => {
          const db = operation.result;
          db.createObjectStore("metadata");
          const messages = db.createObjectStore("messages", { keyPath: "id" });
          if (db.version === 2) messages.createIndex("order", "order", { unique: true });
        };
        operation.onsuccess = () => resolve(operation.result);
        operation.onerror = () => reject(operation.error);
      });
    const payload = {
      authenticated: true,
      cacheScope: "owner",
      cacheExpiresAt: Date.now() + 600_000,
    };
    const source = {
      epoch: "legacy-epoch",
      bootstrap: payload,
      savedAt: 1234,
      session: { id: "session/a", totalMessageCount: 350, messages: [], activeTools: [] },
    };
    const seed = async (version = 1, count = 350) => {
      const db = await open("batty-main-reading-v1", version);
      const tx = db.transaction(["metadata", "messages"], "readwrite");
      const terminal = done(tx);
      tx.objectStore("metadata").put(
        {
          ...source,
          ...(version === 2
            ? { ranges: [{ first: [1, 0], last: [count, 0], complete: true }] }
            : {}),
        },
        "current",
      );
      for (let i = 1; i <= count; i++) {
        const json = JSON.stringify({ id: String(i), role: "user", timestamp: 1, blocks: [] });
        tx.objectStore("messages").put({
          id: version === 2 ? JSON.stringify(["owner", i]) : String(i),
          json,
          timestamp: 1,
          bytes: json.length,
          ...(version === 2 ? { order: [JSON.stringify(["owner", "session/a"]), i, 0] } : {}),
        });
      }
      if (version === 2)
        tx.objectStore("messages").put({
          id: "foreign",
          order: [JSON.stringify(["other", "session/a"]), 1, 0],
          json: "private",
          bytes: 7,
        });
      await terminal;
      db.close();
      localStorage.setItem("batty:main-cache-epoch", "legacy-epoch");
      localStorage.setItem("batty:session-draft:session%2Fa", "matched draft");
      localStorage.setItem("batty:prompt-retry:session%2Fa", "matched retry");
      localStorage.setItem("batty:session-draft:unknown", "unknown draft");
    };
    const snapshot = async (name = storage.installationStorageKey("main-reading-v1")) => {
      const db = await open(name);
      const tx = db.transaction(["metadata", "messages"], "readonly");
      const terminal = done(tx);
      const get = <T>(operation: IDBRequest<T>) =>
        new Promise<T>((resolve) => {
          operation.onsuccess = () => resolve(operation.result);
        });
      const [metadata, marker, count, first] = await Promise.all([
        get(tx.objectStore("metadata").get("current")),
        get(tx.objectStore("metadata").get("legacy-migration")),
        get(tx.objectStore("messages").count()),
        get(
          (db.version === 2
            ? tx.objectStore("messages").index("order")
            : tx.objectStore("messages")
          ).openCursor(),
        ),
      ]);
      const row = first?.value;
      await terminal;
      const version = db.version;
      db.close();
      return { metadata, marker, count, row, version };
    };
    (window as any).legacy = {
      ...migration,
      key: storage.installationStorageKey,
      seed,
      snapshot,
      payload,
      source,
      open,
      done,
    };
  });
  return page;
}
for (const [index, engine] of ["Chromium", "WebKit"].entries()) {
  test(`${engine} resumes bounded v1 migration after abort, without exposing partial metadata or changing legacy data`, async () => {
    const page = await fixture(browsers[index]!);
    const result = await page.evaluate(async () => {
      const t = (window as any).legacy;
      window.__BATTY_BASE_URL__ = "/batty-safe";
      await t.seed();
      const legacyBefore = await t.snapshot("batty-main-reading-v1");
      const nativePut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.getAll = () => {
        throw new Error("Unbounded read");
      };
      let inserted = 0;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === "messages" && ++inserted === 151)
          throw new DOMException("Full", "QuotaExceededError");
        return nativePut.apply(this, args);
      };
      let failure = "";
      try {
        await t.migrateLegacyMainCache(t.payload);
      } catch (error) {
        failure = String(error);
      }
      IDBObjectStore.prototype.put = nativePut;
      const partial = await t.snapshot();
      await t.migrateLegacyMainCache(t.payload);
      const complete = await t.snapshot();
      return {
        failure,
        partial,
        complete,
        legacyBefore,
        legacyAfter: await t.snapshot("batty-main-reading-v1"),
        epoch: localStorage.getItem(t.key("main-cache-epoch")),
        draft: localStorage.getItem(`${t.key("session-draft")}:session%2Fa`),
        retry: localStorage.getItem(`${t.key("prompt-retry")}:session%2Fa`),
        unknown: localStorage.getItem(`${t.key("session-draft")}:unknown`),
        legacyUnknown: localStorage.getItem("batty:session-draft:unknown"),
      };
    });
    expect(result.failure).toContain("Full");
    expect(result.partial.metadata).toBeUndefined();
    expect(result.partial.marker.count).toBe(100);
    expect(result.partial.count).toBe(100);
    expect(result.complete.count).toBe(350);
    expect(result.complete.marker).toBeUndefined();
    expect(result.complete.metadata.ranges).toEqual([
      { first: [1, 0], last: [350, 0], complete: true },
    ]);
    expect(result.complete.metadata.session.messages).toEqual([]);
    expect(result.complete.version).toBe(2);
    expect(result.legacyAfter).toEqual(result.legacyBefore);
    expect(result.epoch).toBeNull();
    expect(result.complete.metadata.epoch).toBeNull();
    expect(result.draft).toBe("matched draft");
    expect(result.retry).toBe("matched retry");
    expect(result.unknown).toBeNull();
    expect(result.legacyUnknown).toBe("unknown draft");
    await page.close();
  });
  test(`${engine} v2 copies only authenticated owner's rows, retains ranges and never overwrites scoped data`, async () => {
    const page = await fixture(browsers[index]!);
    const result = await page.evaluate(async () => {
      const t = (window as any).legacy;
      await t.seed(2, 12);
      localStorage.setItem(t.key("main-cache-epoch"), "independent-scoped-epoch");
      await t.migrateLegacyMainCache(t.payload);
      const root = await t.snapshot();
      const db = await t.open(t.key("main-reading-v1"));
      const tx = db.transaction("metadata", "readwrite");
      const terminal = t.done(tx);
      tx.objectStore("metadata").put({ retained: true }, "current");
      await terminal;
      db.close();
      localStorage.setItem(`${t.key("session-draft")}:session%2Fa`, "new draft");
      await t.migrateLegacyMainCache(t.payload);
      const existing = await t.snapshot();
      window.__BATTY_BASE_URL__ = "/different";
      await t.migrateLegacyMainCache({ ...t.payload, cacheScope: "different-server" });
      const names = (await indexedDB.databases()).map((db) => db.name);
      return {
        root,
        existing,
        names,
        draft: localStorage.getItem("batty:%2F:session-draft:session%2Fa"),
      };
    });
    expect(result.root.count).toBe(12);
    expect(result.root.metadata.epoch).toBe("independent-scoped-epoch");
    expect(result.root.metadata.ranges).toEqual([{ first: [1, 0], last: [12, 0], complete: true }]);
    expect(result.root.row.order).toEqual([JSON.stringify(["owner", "session/a"]), 1, 0]);
    expect(result.existing.metadata).toEqual({ retained: true });
    expect(result.draft).toBe("new draft");
    expect(result.names).not.toContain("batty:%2Fdifferent:main-reading-v1");
    await page.close();
  });
  test(`${engine} refuses mismatched, expired, revoked and unauthenticated legacy ownership`, async () => {
    const page = await fixture(browsers[index]!);
    const result = await page.evaluate(async () => {
      const t = (window as any).legacy;
      await t.seed(1, 1);
      const outcomes = [];
      for (const scenario of [
        "anonymous",
        "scope",
        "expiredPayload",
        "epoch",
        "revoked",
        "scopedRevoked",
        "expiredSource",
      ]) {
        window.__BATTY_BASE_URL__ = `/${scenario}`;
        let payload = { ...t.payload };
        if (scenario === "anonymous") payload.authenticated = false;
        if (scenario === "scope") payload.cacheScope = "foreign";
        if (scenario === "expiredPayload") payload.cacheExpiresAt = 1;
        if (scenario === "epoch") localStorage.setItem("batty:main-cache-epoch", "logout");
        if (scenario === "revoked") localStorage.setItem("batty:revoked-cache-scope", "owner");
        if (scenario === "scopedRevoked")
          localStorage.setItem(t.key("revoked-cache-scope"), "owner");
        if (scenario === "expiredSource") {
          const db = await t.open("batty-main-reading-v1");
          const tx = db.transaction("metadata", "readwrite");
          const terminal = t.done(tx);
          tx.objectStore("metadata").put(
            { ...t.source, bootstrap: { ...t.payload, cacheExpiresAt: 1 } },
            "current",
          );
          await terminal;
          db.close();
        }
        await t.migrateLegacyMainCache(payload);
        outcomes.push(
          (await indexedDB.databases()).some((db) => db.name === t.key("main-reading-v1")),
        );
        localStorage.setItem("batty:main-cache-epoch", "legacy-epoch");
        localStorage.removeItem("batty:revoked-cache-scope");
      }
      return outcomes;
    });
    expect(result).toEqual(Array(7).fill(false));
    await page.close();
  });
  test(`${engine} a scoped logout while queued for the lock cannot authorize an older bootstrap`, async () => {
    const page = await fixture(browsers[index]!);
    const result = await page.evaluate(async () => {
      const t = (window as any).legacy;
      await t.seed();
      let release!: () => void;
      let held!: () => void;
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });
      const blocker = navigator.locks.request(t.key("main-reading-cache"), async () => {
        held();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      await holding;
      const migration = t.migrateLegacyMainCache(t.payload);
      localStorage.setItem(t.key("main-cache-epoch"), "logged-out");
      release();
      await Promise.all([blocker, migration]);
      return {
        databases: (await indexedDB.databases()).map((db) => db.name),
        draft: localStorage.getItem(`${t.key("session-draft")}:session%2Fa`),
        retry: localStorage.getItem(`${t.key("prompt-retry")}:session%2Fa`),
      };
    });
    expect(result.databases).not.toContain("batty:%2F:main-reading-v1");
    expect(result.draft).toBeNull();
    expect(result.retry).toBeNull();
    await page.close();
  });
  test(`${engine} a scoped logout during copying prevents publication and draft import`, async () => {
    const page = await fixture(browsers[index]!);
    const result = await page.evaluate(async () => {
      const t = (window as any).legacy;
      await t.seed();
      const nativePut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        const operation = nativePut.apply(this, args);
        if (this.name === "messages") {
          IDBObjectStore.prototype.put = nativePut;
          operation.addEventListener(
            "success",
            () => localStorage.setItem(t.key("main-cache-epoch"), "logged-out"),
            { once: true },
          );
        }
        return operation;
      };
      await t.migrateLegacyMainCache(t.payload);
      return {
        snapshot: await t.snapshot(),
        epoch: localStorage.getItem(t.key("main-cache-epoch")),
        draft: localStorage.getItem(`${t.key("session-draft")}:session%2Fa`),
      };
    });
    expect(result.snapshot.metadata).toBeUndefined();
    expect(result.epoch).toBe("logged-out");
    expect(result.draft).toBeNull();
    await page.close();
  });
  test(`${engine} absent legacy database is not created`, async () => {
    const page = await fixture(browsers[index]!);
    const names = await page.evaluate(async () => {
      const t = (window as any).legacy;
      await t.migrateLegacyMainCache(t.payload);
      return (await indexedDB.databases()).map((db) => db.name);
    });
    expect(names).not.toContain("batty-main-reading-v1");
    expect(names).not.toContain("batty:%2F:main-reading-v1");
    await page.close();
  });
}
