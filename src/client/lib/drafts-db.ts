import { installationStorageKey } from "./installation-storage";

export interface DraftPayload {
  text: string;
  files: File[];
  retryId?: string;
}

export interface Draft extends DraftPayload {
  id: string;
  createdAt: number;
}

// Entries are immutable. Deletion leaves only the ID so an old snapshot or
// an in-flight upload cannot resurrect it. `pending` is the durable outbox.
export type DraftRecord =
  | { id: string; pending: boolean; draft: Draft }
  | { id: string; pending: boolean; draft?: undefined };

let ownerScope: string | undefined;
export function registerDraftScope(scope: string | undefined): boolean {
  if (!scope) return true;
  if (ownerScope && scope !== ownerScope) return false;
  ownerScope = scope;
  return true;
}
export function draftScope(): string | undefined {
  return ownerScope;
}
export function draftStorageKey(name: string): string {
  return installationStorageKey(`drafts:${ownerScope ?? "fixture"}:${name}`);
}
const name = () => draftStorageKey("database");
let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name(), 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("drafts", { keyPath: "id" });
      request.result.createObjectStore("composers");
    };
    request.onblocked = () => reject(new Error("Draft storage is blocked by another tab"));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = db.onversionchange = () => {
        db.close();
        if (database === pending) database = undefined;
      };
      if (database === pending) resolve(db);
      else db.close();
    };
  });
  database = pending;
  void pending.catch(() => {
    if (database === pending) database = undefined;
  });
  return pending;
}

async function read<T>(store: string, get: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = get(db.transaction(store).objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function write<T>(
  stores: string[],
  change: (tx: IDBTransaction, done: (result: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite", { durability: "strict" });
    let result: T;
    let failure: unknown;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("Draft transaction aborted"));
    const fail = (error: unknown) => {
      failure = error;
      tx.abort();
    };
    try {
      change(tx, (value) => (result = value), fail);
    } catch (error) {
      fail(error);
    }
  });
}

export function listDraftRecords(): Promise<DraftRecord[]> {
  return read("drafts", (store) => store.getAll());
}

export function readComposerSlot(key: string[]): Promise<DraftPayload | undefined> {
  return read("composers", (store) => store.get(key));
}

export function writeComposerSlot(key: string[], payload: DraftPayload): Promise<void> {
  return write(["composers"], (tx) => {
    tx.objectStore("composers").put(payload, key);
  });
}

export function beginSubmission(tab: string, session: string, draft: Draft): Promise<void> {
  return write(["composers"], (tx) => {
    const store = tx.objectStore("composers");
    store.add(draft, [tab, session, draft.id]);
    store.put({ text: "", files: [] }, [tab, session]);
  });
}

export function finishSubmission(
  tab: string,
  session: string,
  draft: Draft,
  disposition: "accepted" | "draft" | "compose",
): Promise<void> {
  return write(disposition === "draft" ? ["composers", "drafts"] : ["composers"], (tx) => {
    const store = tx.objectStore("composers");
    if (disposition === "compose") store.put(draft, [tab, session]);
    if (disposition === "draft") tx.objectStore("drafts").put(pendingRecord(draft));
    store.delete([tab, session, draft.id]);
  });
}

export async function listComposerTabs(): Promise<string[]> {
  const keys = await read("composers", (store) => store.getAllKeys());
  return [...new Set(keys.map((key) => (key as string[])[0]!))];
}

export function recoverComposerSlots(tab: string, flightsOnly = false): Promise<void> {
  return write(["composers", "drafts"], (tx, _done, fail) => {
    const range = IDBKeyRange.bound([tab], [tab, []]);
    const request = tx.objectStore("composers").openCursor(range);
    const drafts = tx.objectStore("drafts");
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (!cursor) return;
        const key = cursor.key as string[];
        if (!flightsOnly || key.length === 3) {
          const payload = cursor.value as DraftPayload;
          if (payload.text.length || payload.files.length) {
            const record = pendingRecord({
              ...payload,
              id: key[2] ?? crypto.randomUUID(),
              createdAt: Date.now(),
            });
            drafts.add(record);
          }
          cursor.delete();
        }
        cursor.continue();
      } catch (error) {
        fail(error);
      }
    };
  });
}

function pendingRecord(draft: Draft): DraftRecord {
  return { id: draft.id, draft, pending: true };
}

export function saveDraft(draft: Draft, slot?: string[]): Promise<void> {
  return write(slot ? ["drafts", "composers"] : ["drafts"], (tx) => {
    tx.objectStore("drafts").add(pendingRecord(draft));
    if (slot) tx.objectStore("composers").put({ text: "", files: [] }, slot);
  });
}

export function consumeDraft(
  slot: string[],
  id: string,
  displaced?: Draft,
): Promise<DraftPayload | undefined> {
  return write(["drafts", "composers"], (tx, done, fail) => {
    const store = tx.objectStore("drafts");
    const request = store.get(id);
    request.onsuccess = () => {
      const current = (request.result as DraftRecord | undefined)?.draft;
      if (!current) return;
      try {
        const { text, files, retryId } = current;
        const payload = { text, files, retryId };
        tx.objectStore("composers").put(payload, slot);
        if (displaced) store.add(pendingRecord(displaced));
        store.put({ id, pending: true } satisfies DraftRecord);
        done(payload);
      } catch (error) {
        fail(error);
      }
    };
  });
}

// Read and compare within the write transaction so overlapping tabs cannot
// mark newer operations as uploaded or re-import a locally removed entry.
function changeDraft(id: string, change: (record?: DraftRecord) => DraftRecord | undefined) {
  return write<void>(["drafts"], (tx, _done, fail) => {
    const store = tx.objectStore("drafts");
    const request = store.get(id);
    request.onsuccess = () => {
      try {
        const next = change(request.result);
        if (next) store.put(next);
      } catch (error) {
        fail(error);
      }
    };
  });
}

export function deleteDraft(id: string): Promise<void> {
  return changeDraft(id, (record) => (record?.draft ? { id, pending: true } : undefined));
}

export function acknowledgeDraft(record: DraftRecord): Promise<void> {
  return changeDraft(record.id, (current) =>
    current?.pending && Boolean(record.draft) === Boolean(current.draft)
      ? { ...current, pending: false }
      : undefined,
  );
}

export function importDraft(draft: Draft): Promise<void> {
  return changeDraft(draft.id, (current) =>
    current ? undefined : { id: draft.id, draft, pending: false },
  );
}

export function observeDraftDeletion(id: string): Promise<void> {
  return changeDraft(id, (current) => (current?.pending ? undefined : { id, pending: false }));
}
