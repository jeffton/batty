import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { rewriteArtifactRow } from "../src/server/artifact-row-codec";
import {
  artifactCandidates,
  artifactColumns,
  artifactDigest,
  artifactIdentity,
  createArtifactStore,
} from "../src/server/artifact-sqlite";

const [mode, path] = process.argv.slice(2);
if (
  process.argv.length !== 4 ||
  !path ||
  !["plan", "apply", "inline", "enable"].includes(mode ?? "")
) {
  throw new Error(
    "Usage: pnpm exec tsx scripts/artifact-dedup.ts plan|apply|inline|enable /path/to/runtime.sqlite",
  );
}
const plan = mode === "plan";
const inline = mode === "inline";
const db = new DatabaseSync(realpathSync(path), { readOnly: plan, timeout: 10_000 });
try {
  if (!plan) db.exec("PRAGMA synchronous=FULL");
  if (mode === "enable") {
    const result = db
      .prepare("UPDATE batty_artifact_encoding_v1 SET writes_enabled=1 WHERE id=1")
      .run();
    if (result.changes !== 1) throw new Error("Artifact encoding is not installed");
    console.log(JSON.stringify({ mode, writesEnabled: true }));
  } else {
    rewriteDatabase();
  }
} finally {
  db.close();
}

function rewriteDatabase() {
  const installed = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE name='batty_artifact_encoding_v1'")
    .get();
  if (!installed && !plan)
    throw new Error("Deploy the artifact-aware runtime before running maintenance");
  const store = installed ? createArtifactStore(db, false) : undefined;
  if (inline) db.exec("UPDATE batty_artifact_encoding_v1 SET writes_enabled=0 WHERE id=1");
  if (
    mode === "apply" &&
    db.prepare("SELECT writes_enabled FROM batty_artifact_encoding_v1 WHERE id=1").get()
      ?.writes_enabled !== 1
  ) {
    throw new Error("Artifact writes are disabled; enable them before applying the migration");
  }
  const prefix = store?.prefix ?? `batty-artifact-v1:${randomBytes(16).toString("hex")}:`;
  const known = new Set<string>();
  let blobBytes = 0;
  const hasBlob = store && db.prepare("SELECT 1 FROM batty_artifact_text_v1 WHERE digest=?");
  const pageBytes = Number(db.prepare("PRAGMA page_size").get()!.page_size);
  const freeBytes = () =>
    Number(db.prepare("PRAGMA freelist_count").get()!.freelist_count) * pageBytes;
  const usedBytes = () => Number(db.prepare("PRAGMA page_count").get()!.page_count) * pageBytes;
  const before = { free: freeBytes(), file: usedBytes() };
  const tables: Record<string, { records: number; serializedBytesSaved: number; lastRow: number }> =
    {};
  for (const spec of artifactColumns) {
    const { table, column } = spec;
    const delta = "delta" in spec ? "kind = 'delta'" : "0";
    const tableStats = (tables[table] = { records: 0, serializedBytesSaved: 0, lastRow: 0 });
    const maximum = Number(db.prepare(`SELECT max(rowid) AS id FROM ${table}`).get()!.id);
    const selectIds = db.prepare(
      `SELECT rowid AS id FROM ${table} WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 500`,
    );
    const select = db.prepare(
      `SELECT ${column} AS raw, ${delta} AS delta, ${artifactIdentity(table)} AS identity
        FROM ${table} WHERE rowid=? AND ${artifactCandidates(column)}`,
    );
    const update = plan ? undefined : db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`);
    let cursor = 0;
    for (
      let rows = selectIds.all(cursor, maximum);
      rows.length;
      rows = selectIds.all(cursor, maximum)
    ) {
      for (const { id } of rows) {
        cursor = Number(id);
        // Scan once without holding a write lock; compare again under the lock for candidates.
        const initial = select.get(cursor);
        if (!initial) continue;
        const raw = initial.raw as string;
        const isDelta = initial.delta === 1;
        const identity = initial.identity as string;
        if ((store?.isPacked(table, identity, raw) ?? false) !== inline) continue;
        let rewritten: string;
        if (plan) {
          rewritten = rewriteArtifactRow(
            raw,
            (text) => {
              if (typeof text !== "string") return text;
              const body = JSON.stringify(text);
              const bytes = Buffer.byteLength(body);
              const digest = artifactDigest(body);
              const reference = { [prefix]: digest };
              if (bytes <= JSON.stringify(reference).length) return text;
              if (!known.has(digest)) {
                known.add(digest);
                if (!hasBlob?.get(digest)) blobBytes += bytes;
              }
              return reference;
            },
            isDelta,
          );
        } else {
          db.exec("BEGIN IMMEDIATE");
          try {
            if (
              db.prepare("SELECT writes_enabled FROM batty_artifact_encoding_v1 WHERE id=1").get()
                ?.writes_enabled !== Number(!inline)
            ) {
              throw new Error("Artifact write mode changed during maintenance");
            }
            const latest = select.get(cursor);
            if (!latest || latest.raw !== raw || latest.identity !== identity) {
              // A concurrent runtime write used the new codec. For inline mode the runtime
              // must already have writes disabled, so any concurrent update already inlined it.
              db.exec("COMMIT");
              continue;
            }
            const original = store!.unpack(raw, isDelta, store!.fingerprint(table, identity));
            rewritten = inline ? original : store!.pack(table, identity, raw, isDelta);
            if (inline) store!.forget(table, identity);
            if (rewritten !== raw) {
              if (
                store!.unpack(rewritten, isDelta, store!.fingerprint(table, identity)) !==
                JSON.stringify(JSON.parse(original))
              ) {
                throw new Error(`Artifact round-trip mismatch for ${table}:${cursor}`);
              }
              update!.run(rewritten, cursor);
            }
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        }
        if (rewritten !== raw) {
          tableStats.records++;
          tableStats.serializedBytesSaved += Buffer.byteLength(raw) - Buffer.byteLength(rewritten);
          tableStats.lastRow = cursor;
        }
      }
    }
    console.error(JSON.stringify({ table, ...tableStats }));
  }
  if (inline) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (
        db.prepare("SELECT writes_enabled FROM batty_artifact_encoding_v1 WHERE id=1").get()
          ?.writes_enabled !== 0
      ) {
        throw new Error("Artifact write mode changed during inverse verification");
      }
      for (const { table, column } of artifactColumns) {
        const rows =
          db.prepare(`SELECT r.identity, t.${column} AS raw, r.digest FROM batty_artifact_rows_v1 r
          JOIN ${table} t ON r.owner=? AND r.identity=${artifactIdentity(table, "t.")}`);
        for (const row of rows.iterate(table)) {
          if (row.digest === artifactDigest(row.raw as string)) {
            throw new Error(`Packed row remains: ${table}:${row.identity}`);
          }
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (!plan) {
    const result = db
      .prepare(
        `SELECT coalesce(sum(length(CAST(body AS BLOB))),0) AS bytes FROM batty_artifact_text_v1`,
      )
      .get();
    blobBytes = Number(result?.bytes);
  }
  console.log(
    JSON.stringify({
      mode,
      tables,
      blobBytes,
      before,
      after: { free: freeBytes(), file: usedBytes() },
    }),
  );
}
