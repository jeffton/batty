import type { BootstrapPayload, SessionState } from "@/shared/types";
import { installationStorageKey } from "./installation-storage";

const LEGACY_DATABASE = "batty-main-reading-v1";
const LEGACY_EPOCH = "batty:main-cache-epoch";
const LEGACY_REVOKED = "batty:revoked-cache-scope";
const MARKER = "legacy-migration";
const BATCH_ROWS = 100;
const BATCH_BYTES = 700 * 1024;
type MessageKey = [number, number];
interface Metadata {
  epoch: string | null;
  bootstrap: BootstrapPayload;
  session: SessionState;
  savedAt: number;
  ranges?: { first: MessageKey; last: MessageKey; complete: boolean }[];
}
interface Row {
  id: string;
  timestamp: number;
  json: string;
  bytes: number;
  order?: [string, number, number];
}
interface Progress {
  source: string;
  after?: IDBValidKey;
  count: number;
  first?: MessageKey;
  last?: MessageKey;
}
function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException("Migration aborted", "AbortError"));
  });
}
async function settled<T>(result: Promise<T>, done: Promise<void>): Promise<T> {
  const results = await Promise.allSettled([result, done]);
  for (const value of results) if (value.status === "rejected") throw value.reason;
  return (results[0] as PromiseFulfilledResult<T>).value;
}
function openLegacy(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    // Do not create or upgrade the shared legacy database, even when it is absent.
    const operation = indexedDB.open(LEGACY_DATABASE);
    let absent = false;
    operation.onupgradeneeded = () => {
      absent = true;
      operation.transaction!.abort();
    };
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => (absent ? resolve(undefined) : reject(operation.error));
  });
}
function openDestination(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const operation = indexedDB.open(installationStorageKey("main-reading-v1"), 2);
    operation.onupgradeneeded = () => {
      const db = operation.result;
      db.createObjectStore("metadata");
      db.createObjectStore("messages", { keyPath: "id" }).createIndex("order", "order", {
        unique: true,
      });
    };
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}
async function metadata(db: IDBDatabase): Promise<Metadata | undefined> {
  const transaction = db.transaction("metadata", "readonly");
  return settled(
    request(transaction.objectStore("metadata").get("current")),
    completed(transaction),
  );
}
function compare(a: MessageKey, b: MessageKey): number {
  return a[0] - b[0] || a[1] - b[1];
}
function authorized(
  payload: BootstrapPayload,
  source: Metadata,
  destinationEpoch: string | null,
): boolean {
  const epoch = localStorage.getItem(installationStorageKey("main-cache-epoch"));
  return Boolean(
    payload.authenticated &&
    payload.cacheScope &&
    payload.cacheExpiresAt! > Date.now() &&
    source.bootstrap.cacheScope === payload.cacheScope &&
    source.bootstrap.cacheExpiresAt! > Date.now() &&
    source.epoch === localStorage.getItem(LEGACY_EPOCH) &&
    payload.cacheScope !== localStorage.getItem(LEGACY_REVOKED) &&
    payload.cacheScope !== localStorage.getItem(installationStorageKey("revoked-cache-scope")) &&
    epoch === destinationEpoch,
  );
}
async function readBatch(db: IDBDatabase, after: IDBValidKey | undefined) {
  const transaction = db.transaction("messages", "readonly");
  const done = completed(transaction);
  const result = new Promise<{ rows: Row[]; after?: IDBValidKey; finished: boolean }>(
    (resolve, reject) => {
      const rows: Row[] = [];
      let bytes = 0;
      let last = after;
      const operation = transaction
        .objectStore("messages")
        .openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true));
      operation.onerror = () => reject(operation.error);
      operation.onsuccess = () => {
        const cursor = operation.result;
        if (
          !cursor ||
          rows.length >= BATCH_ROWS ||
          (rows.length > 0 && bytes + cursor.value.bytes > BATCH_BYTES)
        ) {
          resolve({ rows, after: last, finished: !cursor });
          return;
        }
        const row = cursor.value as Row;
        rows.push(row);
        bytes += row.bytes;
        last = cursor.primaryKey;
        cursor.continue();
      };
    },
  );
  return settled(result, done);
}
async function initialize(db: IDBDatabase, source: string): Promise<Progress | undefined> {
  const transaction = db.transaction(["metadata", "messages"], "readwrite");
  const done = completed(transaction);
  const store = transaction.objectStore("metadata");
  const result = new Promise<Progress | undefined>((resolve, reject) => {
    const current = store.get("current");
    current.onerror = () => reject(current.error);
    current.onsuccess = () => {
      if (current.result) {
        resolve(undefined);
        return;
      }
      const marker = store.get(MARKER);
      marker.onerror = () => reject(marker.error);
      marker.onsuccess = () => {
        if (marker.result?.source === source) {
          resolve(marker.result);
          return;
        }
        const count = transaction.objectStore("messages").count();
        count.onerror = () => reject(count.error);
        count.onsuccess = () => {
          // Only rows identified by our own interrupted marker can be replaced.
          if (count.result && !marker.result) {
            resolve(undefined);
            return;
          }
          transaction.objectStore("messages").clear();
          const progress: Progress = { source, count: 0 };
          store.put(progress, MARKER);
          resolve(progress);
        };
      };
    };
  });
  return settled(result, done);
}
function migrateDrafts(sessionId: string): void {
  for (const name of ["session-draft", "prompt-retry"]) {
    const suffix = `:${encodeURIComponent(sessionId)}`;
    const key = installationStorageKey(name) + suffix;
    const legacy = localStorage.getItem(`batty:${name}${suffix}`);
    if (legacy !== null && localStorage.getItem(key) === null) localStorage.setItem(key, legacy);
  }
}

/** Call only after receiving an online, authenticated bootstrap, before opening the scoped cache. */
export async function migrateLegacyMainCache(payload: BootstrapPayload): Promise<void> {
  if (
    !payload.authenticated ||
    !payload.cacheScope ||
    !payload.cacheExpiresAt ||
    payload.cacheExpiresAt <= Date.now()
  )
    return;
  const destinationEpoch = localStorage.getItem(installationStorageKey("main-cache-epoch"));
  await navigator.locks.request(installationStorageKey("main-reading-cache"), async () => {
    const legacy = await openLegacy();
    if (!legacy) return;
    let destination: IDBDatabase | undefined;
    try {
      const source = await metadata(legacy);
      if (!source || !authorized(payload, source, destinationEpoch)) return;
      const signature = JSON.stringify(source);
      destination = await openDestination();
      let progress = await initialize(destination, signature);
      if (!progress) return;
      const owner = JSON.stringify([payload.cacheScope, source.session.id]);
      for (;;) {
        if (!authorized(payload, source, destinationEpoch)) return;
        const batch = await readBatch(legacy, progress.after);
        const next: Progress = { ...progress, after: batch.after };
        const rows: Row[] = [];
        for (const row of batch.rows) {
          if (legacy.version === 2 && row.order![0] !== owner) continue;
          const key: MessageKey =
            legacy.version === 2
              ? [row.order![1], row.order![2]]
              : (() => {
                  const [id, subid = "0"] = row.id.split(":");
                  return [Number(id), Number(subid)];
                })();
          rows.push({ ...row, order: [owner, ...key] });
          next.count += 1;
          if (!next.first || compare(key, next.first) < 0) next.first = key;
          if (!next.last || compare(key, next.last) > 0) next.last = key;
        }
        if (!authorized(payload, source, destinationEpoch)) return;
        const transaction = destination.transaction(["metadata", "messages"], "readwrite");
        const done = completed(transaction);
        try {
          for (const row of rows) transaction.objectStore("messages").put(row);
          transaction.objectStore("metadata").put(next, MARKER);
        } catch (error) {
          transaction.abort();
          await done.catch(() => {});
          throw error;
        }
        await done;
        progress = next;
        if (batch.finished) break;
      }
      // The global source may have changed while batches were copied. Publish only a coherent snapshot.
      if (
        JSON.stringify(await metadata(legacy)) !== signature ||
        !authorized(payload, source, destinationEpoch)
      )
        return;
      migrateDrafts(source.session.id);
      const transaction = destination.transaction("metadata", "readwrite");
      const done = completed(transaction);
      transaction.objectStore("metadata").put(
        {
          ...source,
          epoch: destinationEpoch,
          bootstrap: { ...source.bootstrap, activeSession: undefined },
          session: { ...source.session, messages: [], activeTools: [], activeAssistant: undefined },
          ranges:
            source.ranges ??
            (progress.first && progress.last
              ? [
                  {
                    first: progress.first,
                    last: progress.last,
                    complete: progress.count >= source.session.totalMessageCount,
                  },
                ]
              : []),
        },
        "current",
      );
      transaction.objectStore("metadata").delete(MARKER);
      await done;
    } finally {
      legacy.close();
      destination?.close();
    }
  });
}
