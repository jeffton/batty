import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { expect, test } from "vite-plus/test";
import { createDiffContentStore, openDiffContentSqliteDatabase } from "./diff-content-sqlite";
import { createHistoryIndex } from "./history-index";
import { encodeRuntimeNotice } from "./runtime-notices";

const before = `before\u0000\ud800😀\\\n${"x".repeat(500)}`;
const after = `${before}\nnew`;
const patch = `${before}\n+new`;
const artifacts = {
  battyFileChanges: [{ path: "example.ts", before, after, patch }],
  fileChanges: [{ path: "example.ts", patch }],
};

function entry(id: number) {
  return {
    id,
    conversationId: 1,
    kind: "pi.model",
    model: [
      {
        role: "user",
        content: encodeRuntimeNotice({
          kind: "subagent",
          text: "Done",
          data: { runtimeResultArtifacts: artifacts },
        }),
      },
      {
        role: "toolResult",
        details: {
          ...artifacts,
          calls: [
            {
              details: artifacts,
              ...artifacts,
              args: { battyFileChanges: artifacts.battyFileChanges },
            },
          ],
          forwardedArtifacts: { fileChanges: artifacts.fileChanges },
          referencedArtifacts: { fileChanges: artifacts.fileChanges },
        },
      },
    ],
  };
}

test("SQLite persists exact file versions once across legacy migration and new writes, reopens and rolls back without losing new writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty-artifact-test-"));
  try {
    const path = join(directory, "runtime.sqlite");
    const db = await openDiffContentSqliteDatabase(path);
    const storage = await SqliteStorage.open(db);
    const index = await createHistoryIndex(db);
    const one = JSON.stringify(entry(1));
    const two = JSON.stringify(entry(2));
    await db.run("INSERT INTO entries VALUES (1,1,NULL,1,?)", one);
    db.enableDiffContentWrites();
    await db.run("INSERT INTO entries VALUES (2,1,NULL,2,?)", two);
    await expect(
      db.transaction(async (tx) => {
        const unpublished = JSON.stringify({
          data: { artifacts: { fileChanges: [{ path: "a", patch: "unpublished".repeat(100) }] } },
        });
        await tx.run("INSERT INTO entries VALUES (3,1,NULL,3,?)", unpublished);
        throw new Error("abort transaction");
      }),
    ).rejects.toThrow("abort transaction");
    expect(await index.count(1)).toBe(4);
    expect((await index.entries(1, undefined, 10)).entries).toEqual([entry(1), entry(2)]);
    await storage.close(context);

    const raw = new DatabaseSync(path);
    try {
      const store = createDiffContentStore(raw, true);
      const read = raw.prepare("SELECT record FROM entries WHERE id=?");
      expect(read.get(1)?.record).toBe(one);
      const packed = read.get(2)?.record as string;
      expect(packed.length).toBeLessThan(two.length / 2);
      expect(packed).toContain(store.prefix);
      expect(
        Object.keys(JSON.parse(packed).model[1].details.referencedArtifacts.fileChanges[0].patch),
      ).toContain(store.prefix);
      expect(JSON.parse(packed).model[1].details.calls[0].args).toEqual({
        battyFileChanges: artifacts.battyFileChanges,
      });
      expect(raw.prepare("SELECT count(*) AS count FROM batty_artifact_text_v1").get()?.count).toBe(
        3,
      );
      raw
        .prepare("UPDATE entries SET record=? WHERE id=1")
        .run(store.pack("entries", "1", one, false));
      expect(raw.prepare("SELECT count(*) AS count FROM batty_artifact_text_v1").get()?.count).toBe(
        3,
      );
    } finally {
      raw.close();
    }
    const reopened = await openDiffContentSqliteDatabase(path);
    try {
      reopened.enableDiffContentWrites();
      const reopenedIndex = await createHistoryIndex(reopened);
      expect((await reopenedIndex.entries(1, undefined, 10)).entries).toEqual([entry(1), entry(2)]);
      const newest = JSON.stringify(entry(3));
      await reopened.run("INSERT INTO entries VALUES (3,1,NULL,3,?)", newest);
      await promisify(execFile)(process.execPath, [
        "--import",
        "tsx",
        "scripts/diff-content-dedup.ts",
        "inline",
        path,
      ]);
      // The same running connection honors the durable rollback barrier.
      const late = JSON.stringify(entry(4));
      await reopened.run("INSERT INTO entries VALUES (4,1,NULL,4,?)", late);
    } finally {
      await reopened.close();
    }
    const rollback = new DatabaseSync(path);
    try {
      const read = rollback.prepare("SELECT record FROM entries WHERE id=?");
      for (const id of [1, 2, 3, 4]) {
        expect(read.get(id)?.record).toBe(JSON.stringify(entry(id)));
      }
    } finally {
      rollback.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("replays revisions with inlined Chord operands before applying deltas", async () => {
  const db = await openDiffContentSqliteDatabase(":memory:");
  const storage = await SqliteStorage.open(db);
  try {
    db.enableDiffContentWrites();
    const id = 10 as never;
    const record = {
      id,
      kind: "batty.worker",
      scope: { kind: "conversation", id: 1 },
      createdAt: 1,
    };
    await db.run(
      "INSERT INTO documents VALUES (?, ?, 0, '', 'conversation', 1, 1, NULL, ?)",
      id,
      '"batty.worker"',
      JSON.stringify(record),
    );
    await db.run(
      "INSERT INTO document_revisions VALUES (?,1,'base',1,?)",
      id,
      JSON.stringify({ latestReport: { artifacts } }),
    );
    await db.run(
      "INSERT INTO document_revisions VALUES (?,2,'delta',1,?)",
      id,
      JSON.stringify([
        ["s", ["latestReport", "artifacts", "fileChanges", 0, "patch"], after],
        ["a", ["latestReport", "artifacts", "fileChanges", 0, "patch"], " end"],
      ]),
    );
    const secondId = 11 as never;
    const packedBase = (await db.get<{ content: string }>(
      "SELECT content FROM document_revisions WHERE document_id=? AND seq=1",
      id,
    ))!.content;
    expect(packedBase).toContain("batty-artifact-v1:");
    await db.run(
      "INSERT INTO documents VALUES (?, ?, 0, '', 'conversation', 2, 1, NULL, ?)",
      secondId,
      '"batty.worker"',
      JSON.stringify({ ...record, id: secondId, scope: { kind: "conversation", id: 2 } }),
    );
    await db.run("INSERT INTO document_revisions VALUES (?,1,'base',1,?)", secondId, packedBase);
    expect((await storage.document(secondId, "current", context))?.value).toEqual(
      JSON.parse(packedBase),
    );
    const result = await storage.document(id, "current", context);
    expect(result?.value).toMatchObject({
      latestReport: { artifacts: { fileChanges: [{ path: "example.ts", patch: `${after} end` }] } },
    });
    expect(
      await db.get<{ count: number }>("SELECT count(*) AS count FROM batty_artifact_text_v1"),
    ).toEqual({ count: 6 });
  } finally {
    await storage.close(context);
  }
});

test("fresh ref-shaped data does not resolve another row's content, including through task upserts", async () => {
  const db = await openDiffContentSqliteDatabase(":memory:");
  await SqliteStorage.open(db);
  db.enableDiffContentWrites();
  const encoding = await db.get<{ namespace: string }>(
    "SELECT namespace FROM batty_artifact_encoding_v1",
  );
  const key = `batty-artifact-v1:${encoding!.namespace}:`;
  await db.run("INSERT INTO entries VALUES (1,1,NULL,1,?)", JSON.stringify(entry(1)));
  const saved = await db.get<{ digest: string }>(
    "SELECT digest FROM batty_artifact_text_v1 LIMIT 1",
  );
  const raw = JSON.stringify({
    data: {
      artifacts: {
        fileChanges: [
          { path: "object", patch: { [key]: saved!.digest } },
          { path: "known", patch: key + saved!.digest },
          { path: "unknown", patch: key + "x".repeat(43) },
        ],
      },
    },
  });
  const upsert =
    "INSERT INTO tasks VALUES (2,2,'fixture','terminal',0,0,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record";
  await db.run(upsert, "{}");
  await db.run(upsert, raw);
  const task = db.get<{ record: string }>("SELECT record FROM tasks WHERE id=2");
  const records = db.all<{ record: string }>("SELECT record FROM entries WHERE id=1");
  await db.close();
  expect(await task).toEqual({ record: raw });
  expect(await records).toEqual([{ record: JSON.stringify(entry(1)) }]);
});
