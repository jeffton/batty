import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertArtifactPresentationReady,
  migrateArtifactPresentation,
} from "../src/server/artifact-presentation-migration";
import { openDiffContentSqliteDatabase } from "../src/server/diff-content-sqlite";
import { acquireLock } from "../src/server/lock";

const [action, directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length || !["inspect", "migrate", "validate"].includes(action ?? "")) {
  throw new Error(
    "Usage: node --import tsx scripts/migrate-artifact-presentation.ts inspect|migrate|validate STATE_DIRECTORY",
  );
}
const root = resolve(directory);
const path = join(root, "runtime.sqlite");
if (!(await stat(path)).isFile()) throw new Error("State directory must contain runtime.sqlite");
const release = await acquireLock(join(root, "runtime.lock"));
try {
  const db = await openDiffContentSqliteDatabase(
    path,
    action === "migrate" ? "read-write" : "read-only",
  );
  try {
    if (action === "validate") {
      await assertArtifactPresentationReady(db);
      const results = await db.all<{ quick_check: string }>("PRAGMA quick_check");
      if (results.length !== 1 || results[0]?.quick_check !== "ok")
        throw new Error("SQLite quick_check failed");
      console.log("Artifact presentation readiness and SQLite integrity checks passed");
    } else {
      if (action === "migrate") db.enableDiffContentWrites();
      const counts = await migrateArtifactPresentation(db, action === "inspect");
      console.log(JSON.stringify(counts, null, 2));
    }
  } finally {
    await db.close();
  }
} finally {
  await release();
}
