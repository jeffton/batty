import type {
  BootstrapPayload,
  SessionMessagesPage,
  SessionState,
  UiMessage,
} from "@/shared/types";

export const CACHE_DAY_MS = 86_400_000;
const PAGE_BYTE_BUDGET = 700 * 1024;
const PAGE_SIZE = 50;
const DB_NAME = "batty-main-reading-v1";
export const CACHE_EPOCH_KEY = "batty:main-cache-epoch";
export const REVOKED_CACHE_SCOPE_KEY = "batty:revoked-cache-scope";
let admittedEpoch = localStorage.getItem(CACHE_EPOCH_KEY);
export function registerMainCacheBootstrap(): void {
  admittedEpoch = localStorage.getItem(CACHE_EPOCH_KEY);
}
function isCacheAuthorized(): boolean {
  return admittedEpoch === localStorage.getItem(CACHE_EPOCH_KEY);
}
interface MessageRecord {
  id: string;
  timestamp: number;
  json: string;
  bytes: number;
  order: [string, number, number];
}
type MessageKey = [number, number];
interface CachedRange {
  first: MessageKey;
  last: MessageKey;
  complete: boolean;
}
interface CacheMetadata {
  epoch: string | null;
  bootstrap: BootstrapPayload;
  session: SessionState;
  savedAt: number;
  ranges: CachedRange[];
}
let database: Promise<IDBDatabase> | undefined;
const owners = new WeakMap<IDBDatabase, Promise<IDBDatabase>>();
let queue = Promise.resolve();
let generation = 0;
const serialized = new WeakMap<UiMessage, MessageRecord>();
const activeTransactions = new Set<IDBTransaction>();
const lifecycleAborts = new WeakSet<IDBTransaction>();

export class CacheSuspendedError extends Error {
  constructor() {
    super("Cache operation cancelled: page suspended");
    this.name = "AbortError";
  }
}
function requireForeground(): void {
  if (document.visibilityState === "hidden") throw new CacheSuspendedError();
}

function request<T>(request: IDBRequest<T>): Promise<T> {
  // Native DOMExceptions on iOS have no JS stack. Capture the issuing site,
  // retaining the native name/message for the UI and allowlisted telemetry.
  const failure = new Error();
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      failure.name = request.error!.name;
      failure.message = request.error!.message;
      reject(failure);
    };
  });
}

async function readMetadata(db: IDBDatabase) {
  requireForeground();
  const transaction = db.transaction(["metadata", "messages"], "readonly");
  const done = transactionDone(transaction, "read");
  const results = await Promise.allSettled([
    request(transaction.objectStore("metadata").get("current")) as Promise<
      CacheMetadata | undefined
    >,
    done,
  ]);
  // Join the terminal abort before releasing the save lock or reusing the connection.
  const failures = results.filter((result) => result.status === "rejected");
  const failure =
    failures.find((result) => result.reason?.name !== "AbortError") ??
    failures.find((result) => result.reason instanceof CacheSuspendedError) ??
    failures[0];
  if (failure) throw failure.reason;
  return (results[0] as PromiseFulfilledResult<CacheMetadata | undefined>).value;
}
function transactionDone(
  transaction: IDBTransaction,
  phase: "read" | "write" | "clear",
): Promise<void> {
  if (phase !== "clear") activeTransactions.add(transaction);
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      activeTransactions.delete(transaction);
      closeReleasedConnection(transaction.db);
      resolve();
    };
    // Settle only on the terminal event; the save lock must outlive the transaction.
    transaction.onabort = () => {
      activeTransactions.delete(transaction);
      const db = transaction.db;
      if (database === owners.get(db)) database = undefined;
      closeReleasedConnection(db);
      // Only our own successful abort is a lifecycle cancellation. Native failures,
      // including UnknownError and quota errors during backgrounding, stay errors.
      const cancelled =
        lifecycleAborts.has(transaction) &&
        (!transaction.error || transaction.error.name === "AbortError");
      reject(
        cancelled
          ? new CacheSuspendedError()
          : (transaction.error ?? new Error(`Cache transaction aborted: ${phase}`)),
      );
    };
  });
}
function suspendCache(): void {
  for (const transaction of activeTransactions) {
    try {
      transaction.abort();
      lifecycleAborts.add(transaction);
    } catch (error) {
      // commit() or a terminal event can already have made abort unavailable.
      if (!(error instanceof DOMException) || error.name !== "InvalidStateError") throw error;
    }
  }
  releaseConnection();
}
function closeReleasedConnection(db: IDBDatabase): void {
  if (
    database !== owners.get(db) &&
    ![...activeTransactions].some((transaction) => transaction.db === db)
  )
    db.close();
}
function releaseConnection(): void {
  const pending = database;
  database = undefined;
  // Revoke ownership immediately; close after terminal transaction events.
  // Native WebKit can delay abort delivery if close races an explicit abort.
  void pending?.then(closeReleasedConnection, () => {});
}
window.addEventListener("pagehide", suspendCache);
// Switching iOS apps can suspend the storage process without pagehide. Drop the
// connection on both transitions: foreground is also a boundary when WebKit
// delivered no background event before suspension. Explicitly cancel unfinished
// work on backgrounding instead of leaving it to a suspended native connection.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") suspendCache();
  else releaseConnection();
});
async function open(): Promise<IDBDatabase> {
  for (;;) {
    const pending = openConnection();
    const db = await pending;
    // Visibility can revoke an open that has not delivered its success event
    // yet. Never hand that closing connection to a new transaction.
    if (database === pending) return db;
  }
}
function openConnection(): Promise<IDBDatabase> {
  if (database) return database;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const operation = indexedDB.open(DB_NAME, 2);
    operation.onupgradeneeded = (event) => {
      const db = operation.result;
      const transaction = operation.transaction!;
      if (event.oldVersion === 0) {
        db.createObjectStore("metadata");
        db.createObjectStore("messages", { keyPath: "id" });
      }
      const messages = transaction.objectStore("messages");
      messages.createIndex("order", "order", { unique: true });
      // Upgrade in-place, one row at a time, retaining every v1 record.
      const metadataRequest = transaction.objectStore("metadata").get("current");
      metadataRequest.onsuccess = () => {
        const metadata = metadataRequest.result as CacheMetadata | undefined;
        if (!metadata) return;
        const owner = cacheOwner(metadata.bootstrap, metadata.session);
        let first: MessageKey | undefined;
        let last: MessageKey | undefined;
        let count = 0;
        const cursorRequest = messages.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) {
            const row = cursor.value as MessageRecord;
            const key = messageKey(row.id);
            count += 1;
            if (!first || compareKeys(key, first) < 0) first = key;
            if (!last || compareKeys(key, last) > 0) last = key;
            cursor.update({ ...row, order: [owner, ...key] });
            cursor.continue();
          } else {
            metadata.ranges =
              first && last
                ? [{ first, last, complete: count >= metadata.session.totalMessageCount }]
                : [];
            metadata.bootstrap = { ...metadata.bootstrap, activeSession: undefined };
            metadata.session = {
              ...metadata.session,
              messages: [],
              activeTools: [],
              activeAssistant: undefined,
            };
            transaction.objectStore("metadata").put(metadata, "current");
          }
        };
      };
    };
    operation.onsuccess = () => {
      const db = operation.result;
      owners.set(db, pending);
      db.onclose = () => {
        if (database === pending) database = undefined;
      };
      db.onversionchange = () => {
        if (database === pending) database = undefined;
        db.close();
      };
      resolve(db);
    };
    operation.onerror = () => {
      if (database === pending) database = undefined;
      reject(operation.error);
    };
  });
  database = pending;
  return pending;
}

function messageKey(id: string): MessageKey {
  const [entry, subid = "0"] = id.split(":");
  return [Number(entry), Number(subid)];
}
function compareKeys(a: MessageKey, b: MessageKey): number {
  return a[0] - b[0] || a[1] - b[1];
}
function cacheOwner(bootstrap: BootstrapPayload, session: SessionState): string {
  return JSON.stringify([bootstrap.cacheScope, session.id]);
}
function authorizedMetadata(metadata: CacheMetadata | undefined): metadata is CacheMetadata {
  return Boolean(
    metadata &&
    metadata.epoch === localStorage.getItem(CACHE_EPOCH_KEY) &&
    metadata.bootstrap.cacheScope !== localStorage.getItem(REVOKED_CACHE_SCOPE_KEY) &&
    metadata.bootstrap.cacheExpiresAt &&
    metadata.bootstrap.cacheExpiresAt > Date.now(),
  );
}

export interface MainCachePageOptions {
  sessionId: string;
  before?: string;
  limit?: number;
}
export interface MainCacheSavePage {
  /** Exclusive server-page cursor. Certifies continuity across the page boundary. */
  before?: string;
  hasMoreMessages?: boolean;
}

function mergeRanges(ranges: CachedRange[], incoming: CachedRange): CachedRange[] {
  const sorted = [...ranges, incoming].sort((a, b) => compareKeys(a.first, b.first));
  const merged: CachedRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || compareKeys(previous.last, range.first) < 0) {
      merged.push({ ...range });
      continue;
    }
    if (compareKeys(previous.first, range.first) === 0) previous.complete ||= range.complete;
    if (compareKeys(range.last, previous.last) > 0) previous.last = range.last;
  }
  return merged;
}

async function readSnapshot(
  options?: MainCachePageOptions,
): Promise<{ metadata: CacheMetadata; page: SessionMessagesPage } | undefined> {
  requireForeground();
  const db = await open();
  const transaction = db.transaction(["metadata", "messages"], "readonly");
  const done = transactionDone(transaction, "read");
  const snapshot = new Promise<{ metadata: CacheMetadata; page: SessionMessagesPage } | undefined>(
    (resolve, reject) => {
      transaction.addEventListener("abort", () =>
        reject(
          lifecycleAborts.has(transaction)
            ? new CacheSuspendedError()
            : (transaction.error ?? new DOMException("Cache read aborted", "AbortError")),
        ),
      );
      const metadataRequest = transaction.objectStore("metadata").get("current");
      metadataRequest.onerror = () => reject(metadataRequest.error);
      metadataRequest.onsuccess = () => {
        if (lifecycleAborts.has(transaction)) {
          reject(new CacheSuspendedError());
          return;
        }
        const metadata = metadataRequest.result as CacheMetadata | undefined;
        if (
          !authorizedMetadata(metadata) ||
          (options && options.sessionId !== metadata.session.id)
        ) {
          resolve(undefined);
          return;
        }
        const before = options?.before ? messageKey(options.before) : undefined;
        const range = before
          ? metadata.ranges.find(
              (candidate) =>
                compareKeys(candidate.first, before) <= 0 &&
                compareKeys(before, candidate.last) <= 0,
            )
          : metadata.ranges.at(-1);
        if (!range) {
          resolve(
            !before && metadata.ranges.length === 0
              ? {
                  metadata,
                  page: {
                    messages: [],
                    totalMessageCount: metadata.session.totalMessageCount,
                    hasMoreMessages: Boolean(
                      metadata.session.hasMoreMessages || metadata.session.totalMessageCount > 0,
                    ),
                  },
                }
              : undefined,
          );
          return;
        }
        // The next row might lie across an unsynchronized hole. Let the server
        // answer instead of silently jumping to a disconnected older range.
        if (before && compareKeys(before, range.first) === 0 && !range.complete) {
          resolve(undefined);
          return;
        }
        const owner = cacheOwner(metadata.bootstrap, metadata.session);
        const messages: UiMessage[] = [];
        const limit = options?.limit ?? PAGE_SIZE;
        let bytes = 0;
        const finish = () =>
          resolve({
            metadata,
            page: {
              messages: messages.reverse(),
              totalMessageCount: metadata.session.totalMessageCount,
              hasMoreMessages:
                !range.complete ||
                (messages.length > 0 && compareKeys(messageKey(messages[0]!.id), range.first) > 0),
            },
          });
        if (before && compareKeys(before, range.first) === 0) {
          finish();
          return;
        }
        const keys = IDBKeyRange.bound(
          [owner, ...range.first],
          [owner, ...(before ?? range.last)],
          false,
          Boolean(before),
        );
        const cursorRequest = transaction
          .objectStore("messages")
          .index("order")
          .openCursor(keys, "prev");
        cursorRequest.onerror = () => reject(cursorRequest.error);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            finish();
            return;
          }
          const row = cursor.value as MessageRecord;
          // Always allow one oversized message; never truncate message content.
          if (
            messages.length &&
            (messages.length >= limit || bytes + row.bytes > PAGE_BYTE_BUDGET)
          ) {
            finish();
            return;
          }
          messages.push(JSON.parse(row.json) as UiMessage);
          bytes += row.bytes;
          cursor.continue();
        };
      };
    },
  );
  const results = await Promise.allSettled([snapshot, done]);
  const failures = results.filter((result) => result.status === "rejected");
  const failure =
    failures.find((result) => result.reason?.name !== "AbortError") ??
    failures.find((result) => result.reason instanceof CacheSuspendedError) ??
    failures[0];
  if (failure) throw failure.reason;
  const result = (results[0] as PromiseFulfilledResult<Awaited<typeof snapshot>>).value;
  return result && authorizedMetadata(result.metadata) ? result : undefined;
}

export function authorizePreviewCache(bootstrap: BootstrapPayload): void {
  if (
    !isCacheAuthorized() ||
    bootstrap.cacheScope === localStorage.getItem(REVOKED_CACHE_SCOPE_KEY)
  )
    return;
  navigator.serviceWorker?.controller?.postMessage({
    type: "authorize-private-previews",
    scope: bootstrap.cacheScope,
    expiresAt: bootstrap.cacheExpiresAt,
    cacheEpoch: admittedEpoch,
  });
}

export async function readMainCache(): Promise<CacheMetadata | undefined> {
  const result = await readSnapshot();
  if (!result) return undefined;
  authorizePreviewCache(result.metadata.bootstrap);
  return {
    ...result.metadata,
    session: { ...result.metadata.session, ...result.page },
  };
}

export async function readMainCachePage(
  options: MainCachePageOptions,
): Promise<SessionMessagesPage | undefined> {
  return (await readSnapshot(options))?.page;
}

/**
 * Each supplied array must be a contiguous server window/page, not disconnected
 * history concatenated with a live tail. Omitted rows are never deleted.
 */
export function saveMainCache(
  bootstrap: BootstrapPayload,
  session: SessionState,
  messages: UiMessage[] = session.messages,
  page: MainCacheSavePage = {},
): Promise<void> {
  if (
    !isCacheAuthorized() ||
    bootstrap.cacheScope === localStorage.getItem(REVOKED_CACHE_SCOPE_KEY) ||
    !bootstrap.cacheScope ||
    session.isSubagentSession ||
    session.isCronSession
  )
    return Promise.resolve();
  authorizePreviewCache(bootstrap);
  const admitted = generation;
  const operation = queue.then(() =>
    navigator.locks.request("batty-main-reading-cache", async () => {
      if (admitted !== generation || !isCacheAuthorized()) return;
      requireForeground();
      const db = await open();
      const oldMetadata = await readMetadata(db);
      if (admitted !== generation || !isCacheAuthorized()) return;
      const sameScope =
        oldMetadata?.bootstrap.cacheScope === bootstrap.cacheScope &&
        oldMetadata?.session.id === session.id;
      if (
        sameScope &&
        oldMetadata.session.streamId === session.streamId &&
        (oldMetadata.session.revision ?? 0) > (session.revision ?? 0)
      )
        return;
      const owner = cacheOwner(bootstrap, session);
      const rows = messages.map((message) => {
        let row = serialized.get(message);
        if (!row || row.order[0] !== owner) {
          const json = JSON.stringify(message);
          row = {
            id: JSON.stringify([owner, message.id]),
            timestamp: message.timestamp,
            json,
            bytes: new TextEncoder().encode(json).byteLength,
            order: [owner, ...messageKey(message.id)],
          };
          serialized.set(message, row);
        }
        return row;
      });
      let ranges = sameScope ? oldMetadata.ranges : [];
      if (rows.length) {
        const keys = rows
          .map((row) => [row.order[1], row.order[2]] as MessageKey)
          .sort(compareKeys);
        const first = keys[0]!;
        let last = keys.at(-1)!;
        if (page.before) {
          const boundary = messageKey(page.before);
          const joined = ranges.find(
            (range) =>
              compareKeys(range.first, boundary) <= 0 && compareKeys(boundary, range.last) <= 0,
          );
          if (joined && compareKeys(last, boundary) < 0) last = boundary;
        }
        ranges = mergeRanges(ranges, {
          first,
          last,
          complete:
            page.hasMoreMessages === false ||
            (messages === session.messages &&
              (session.hasMoreMessages === false || session.totalMessageCount <= messages.length)),
        });
      }
      // Strip transient assistant/tool payloads as well as messages: metadata
      // stays bounded even when a live tool returns a very large report.
      const metadata: CacheMetadata = {
        epoch: admittedEpoch,
        bootstrap: { ...bootstrap, activeSession: undefined },
        session: { ...session, messages: [], activeTools: [], activeAssistant: undefined },
        ranges,
        savedAt: Date.now(),
      };
      const plainMetadata = JSON.parse(JSON.stringify(metadata));
      const writeDb = await open();
      if (admitted !== generation || !isCacheAuthorized()) return;
      requireForeground();
      const transaction = writeDb.transaction(["metadata", "messages"], "readwrite");
      const done = transactionDone(transaction, "write");
      const store = transaction.objectStore("messages");
      let writeError: unknown;
      let remaining = rows.length;
      try {
        for (const row of rows) {
          // Preserve v1 primary keys while new records use scope-qualified IDs.
          const existingKey = store.index("order").getKey(row.order);
          existingKey.onsuccess = () => {
            try {
              store.put({ ...row, id: existingKey.result ?? row.id });
              remaining -= 1;
              if (remaining === 0) transaction.commit();
            } catch (error) {
              writeError = error;
              transaction.abort();
            }
          };
        }
        transaction.objectStore("metadata").put(plainMetadata, "current");
        // Enqueue all upserts before committing, keeping rows/ranges/metadata atomic.
        if (!rows.length) transaction.commit();
      } catch (error) {
        transaction.abort();
        await done.catch(() => {});
        throw error;
      }
      try {
        await done;
      } catch (error) {
        throw writeError ?? error;
      }
    }),
  );
  queue = operation.catch(() => {});
  return operation;
}

export async function clearMainCache(cacheEpoch: string = crypto.randomUUID()): Promise<string> {
  localStorage.setItem(CACHE_EPOCH_KEY, cacheEpoch);
  generation += 1;
  await queue;
  await navigator.locks.request("batty-main-reading-cache", async () => {
    const db = await open();
    const transaction = db.transaction(["metadata", "messages"], "readwrite");
    const done = transactionDone(transaction, "clear");
    transaction.objectStore("metadata").clear();
    transaction.objectStore("messages").clear();
    transaction.commit();
    await done;
  });
  const worker = navigator.serviceWorker?.controller;
  if (worker)
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        reject(new Error("Private preview cache clearing timed out"));
      }, 20_000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        channel.port1.close();
        if (event.data.error) reject(new Error(event.data.error));
        else resolve();
      };
      worker.postMessage({ type: "clear-private-previews", cacheEpoch }, [channel.port2]);
    });
  return cacheEpoch;
}
