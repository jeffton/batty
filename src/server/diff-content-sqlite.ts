import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { diffContentKeys, rewriteDiffContentRow } from "./diff-content-row-codec";

export const diffContentColumns = [
  { table: "entries", column: "record", updates: true },
  { table: "tasks", column: "record", updates: true },
  { table: "document_revisions", column: "content", delta: true },
] as const;

type DiffContentTable = (typeof diffContentColumns)[number]["table"];

export function diffContentIdentity(table: DiffContentTable, qualifier = "") {
  return table === "document_revisions"
    ? `${qualifier}document_id || ':' || ${qualifier}seq`
    : `CAST(${qualifier}id AS TEXT)`;
}

export const diffContentCandidates = (column: string) =>
  `(${diffContentKeys.map((key) => `instr(${column}, '${key}') > 0`).join(" OR ")})`;

export function diffContentDigest(body: string) {
  return createHash("sha256").update(body).digest("base64url");
}

export function createDiffContentStore(db: DatabaseSync, initialize: boolean) {
  if (initialize) {
    db.exec(`CREATE TABLE IF NOT EXISTS batty_artifact_text_v1 (
      digest TEXT PRIMARY KEY NOT NULL,
      body TEXT NOT NULL
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS batty_artifact_encoding_v1 (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      namespace TEXT NOT NULL,
      writes_enabled INTEGER NOT NULL CHECK (writes_enabled IN (0, 1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS batty_artifact_rows_v1 (
      owner TEXT NOT NULL,
      identity TEXT NOT NULL,
      digest TEXT NOT NULL,
      PRIMARY KEY (owner, identity)
    ) STRICT, WITHOUT ROWID;`);
    db.prepare("INSERT OR IGNORE INTO batty_artifact_encoding_v1 VALUES (1, ?, 1)").run(
      randomBytes(16).toString("hex"),
    );
  }
  const row = db.prepare("SELECT namespace FROM batty_artifact_encoding_v1 WHERE id=1").get();
  const prefix = `batty-artifact-v1:${row!.namespace}:`;
  const read = db.prepare("SELECT body FROM batty_artifact_text_v1 WHERE digest=?");
  const registered = db.prepare(
    "SELECT digest FROM batty_artifact_rows_v1 WHERE owner=? AND identity=?",
  );
  const insert = db.prepare(
    "INSERT INTO batty_artifact_text_v1 VALUES (?, ?) ON CONFLICT(digest) DO NOTHING",
  );
  const register = db.prepare(`INSERT INTO batty_artifact_rows_v1 VALUES (?, ?, ?)
    ON CONFLICT(owner, identity) DO UPDATE SET digest=excluded.digest`);
  const forget = db.prepare("DELETE FROM batty_artifact_rows_v1 WHERE owner=? AND identity=?");
  const isPacked = (table: string, key: string, raw: string) =>
    raw.includes(prefix) && registered.get(table, key)?.digest === diffContentDigest(raw);
  return {
    prefix,
    isPacked,
    fingerprint(table: string, key: string) {
      return registered.get(table, key)?.digest;
    },
    forget(table: string, key: string) {
      forget.run(table, key);
    },
    pack(table: string, key: string, raw: string, delta: boolean, enabled = true) {
      if (!enabled) {
        forget.run(table, key);
        return raw;
      }
      const seen = new Set<string>();
      const packed = rewriteDiffContentRow(
        raw,
        (value) => {
          // An object in a fresh write is data, never a reference. If shaped like
          // one, escape the entire object and resolve its bytes only once on read.
          const escape = value && typeof value === "object" && Object.hasOwn(value, prefix);
          if (typeof value !== "string" && !escape) return value;
          const body = JSON.stringify(value);
          if (!escape && Buffer.byteLength(body) <= prefix.length + 50) return value;
          const digest = diffContentDigest(body);
          if (!seen.has(digest)) {
            seen.add(digest);
            insert.run(digest, body);
          }
          return { [prefix]: digest };
        },
        delta,
      );
      if (packed !== raw) register.run(table, key, diffContentDigest(packed));
      else forget.run(table, key);
      return packed;
    },
    unpack(raw: string, delta: boolean, fingerprint: unknown) {
      if (typeof fingerprint !== "string") return raw;
      if (diffContentDigest(raw) !== fingerprint) {
        throw new Error("Batty diff-content row does not match its storage fingerprint");
      }
      const decoded = new Map<string, unknown>();
      return rewriteDiffContentRow(
        raw,
        (value) => {
          if (!value || typeof value !== "object" || Object.keys(value).length !== 1) return value;
          const digest = (value as Record<string, unknown>)[prefix];
          if (typeof digest !== "string") return value;
          let body = decoded.get(digest);
          if (body === undefined) {
            const saved = read.get(digest);
            if (typeof saved?.body !== "string" || diffContentDigest(saved.body) !== digest) {
              throw new Error(`Missing or corrupt Batty diff content: ${digest}`);
            }
            body = JSON.parse(saved.body);
            decoded.set(digest, body);
          }
          return body;
        },
        delta,
      );
    },
  };
}

function diffContentProjection(table: DiffContentTable, qualifier: string) {
  return `'${table}' AS __diff_content_table, (SELECT digest FROM batty_artifact_rows_v1
    WHERE owner='${table}' AND identity=${diffContentIdentity(table, qualifier)}) AS __diff_content_digest`;
}

// Pi 1.6 and Batty's history index project the complete JSON columns with these
// SELECT shapes. Add the durable row identity without replacing indexed predicates.
// Partial JSON projections (counts, usage, ownership) don't read artifact leaves.
function diffContentRead(sql: string) {
  const revision = /^\s*SELECT seq, kind, version, content FROM document_revisions\b/i.exec(sql);
  if (revision) {
    return sql.replace(
      /\bcontent FROM/i,
      `content, ${diffContentProjection("document_revisions", "document_revisions.")} FROM`,
    );
  }
  const record =
    /^\s*SELECT (e\.)?record(?:, commit_seq)? FROM (entries|tasks|batty_entry_visibility)\b/i.exec(
      sql,
    );
  if (!record) return sql;
  const qualifier = record[1] ?? "";
  const table = record[2] === "tasks" ? "tasks" : "entries";
  return sql.replace(
    /\brecord(?=, commit_seq| FROM)/i,
    `record, ${diffContentProjection(table, qualifier || `${table}.`)}`,
  );
}

class DiffContentSqliteDatabase extends NodeSqliteDatabase {
  constructor(
    db: DatabaseSync,
    private readonly store: ReturnType<typeof createDiffContentStore>,
    mode: "read-only" | "read-write",
  ) {
    super(db, mode);
  }

  enableDiffContentWrites() {
    this.database.function("batty_pack_diff_content", (table, key, raw, delta, enabled) =>
      this.store.pack(table as string, key as string, raw as string, delta === 1, enabled === 1),
    );
    this.database.exec("CREATE TEMP TABLE batty_diff_content_pack_guard (active INTEGER)");
    for (const spec of diffContentColumns) {
      const { table, column } = spec;
      const key = diffContentIdentity(table, "new.");
      const delta = "delta" in spec ? "new.kind = 'delta'" : "0";
      for (const event of "updates" in spec ? ["INSERT", `UPDATE OF ${column}`] : ["INSERT"]) {
        this.database.exec(`CREATE TEMP TRIGGER batty_pack_${table}_${event.split(" ")[0]}
          AFTER ${event} ON main.${table}
          WHEN NOT EXISTS (SELECT 1 FROM batty_diff_content_pack_guard)
            AND (${diffContentCandidates(`new.${column}`)} OR EXISTS (
              SELECT 1 FROM batty_artifact_rows_v1 WHERE owner='${table}' AND identity=${key}))
          BEGIN
            INSERT INTO batty_diff_content_pack_guard VALUES (1);
            UPDATE ${table} SET ${column}=batty_pack_diff_content('${table}', ${key}, new.${column}, ${delta},
              (SELECT writes_enabled FROM batty_artifact_encoding_v1 WHERE id=1))
              WHERE rowid=new.rowid;
            DELETE FROM batty_diff_content_pack_guard;
          END;`);
      }
    }
  }

  private hydrate<T extends object>(row: T): T {
    const fields = row as Record<string, unknown>;
    const table = fields.__diff_content_table;
    if (typeof table !== "string") return row;
    const digest = fields.__diff_content_digest;
    delete fields.__diff_content_table;
    delete fields.__diff_content_digest;
    if (table === "document_revisions") {
      fields.content = this.store.unpack(fields.content as string, fields.kind === "delta", digest);
    } else {
      fields.record = this.store.unpack(fields.record as string, false, digest);
    }
    return row;
  }

  override get<T extends object>(sql: string, ...params: SqliteValue[]) {
    return super.get<T>(diffContentRead(sql), ...params);
  }

  override all<T extends object>(sql: string, ...params: SqliteValue[]) {
    return super.all<T>(diffContentRead(sql), ...params);
  }

  protected override runOperation<T>(operation: () => T): Promise<T> {
    return super.runOperation(() => {
      const result = operation();
      if (Array.isArray(result)) {
        for (const row of result) this.hydrate(row);
      } else if (result && typeof result === "object") {
        this.hydrate(result);
      }
      return result;
    });
  }

  override transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
    return super.transaction((tx) =>
      callback({
        exec: tx.exec.bind(tx),
        run: tx.run.bind(tx),
        runCounted: tx.runCounted.bind(tx),
        get: async <R extends object>(sql: string, ...params: SqliteValue[]) => {
          const row = await tx.get<R>(diffContentRead(sql), ...params);
          return row && this.hydrate(row);
        },
        all: async <R extends object>(sql: string, ...params: SqliteValue[]) =>
          (await tx.all<R>(diffContentRead(sql), ...params)).map((row) => this.hydrate(row)),
      }),
    );
  }
}

export async function openDiffContentSqliteDatabase(
  path: string,
  mode: "read-only" | "read-write" = "read-write",
) {
  const readOnly = mode === "read-only";
  if (!readOnly && path !== ":memory:") await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5_000, readOnly });
  try {
    if (!readOnly)
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000");
    return new DiffContentSqliteDatabase(db, createDiffContentStore(db, !readOnly), mode);
  } catch (error) {
    db.close();
    throw error;
  }
}
