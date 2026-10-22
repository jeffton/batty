import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  Harness,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, test } from "vite-plus/test";

// Generated with the real 1.2.0 SDK from /opt/batty2/current/node_modules on
// 2026-10-22, against an isolated temporary database (never production data).
// Gzipped JSON contains sqlite_master DDL and all rows, not a hand-written
// approximation of schema 1. root.commit created a pending background task
// with input { value: 42 } and two document edits in separate commits.
// Keeping the fixture here also lets this test run after 1.2 is uninstalled.
const legacyFixture =
  "H4sIAAAAAAAAA8VZW0/bSBT+K6PzApGGioQAqaWuxNJoi9oNqzSrbYWjaGIPMIszDjNjKEL576u52B47NglbqrzFPmfO5TvXcZ5BRrd0QSC4gvPx8GwyRJOz378MUZTyByokUSzlEu2HPFShYjG6GE2GfwzH6K/xxZ9n4+/o8/A7tsT0kVMx88/NSv4KjyLybp0maJSKGE2G3yZodDlBo7+/fEHnn4bnn9H+vzLlsweSsHjfsnU6+lAHfZ2ML84ngKvGx2mULShXM0EfmPQ9KCieK7kyZ4ek922kO8ZbDDSUixHa35sTSfcw2otposhep+OOalBYytskRylXlKuN3ju+QqwXBrTvOYeRpPdbYbRdcNc9d4RrsmDJ05pbuekFGe0fYtQt7L6jT9qjjDYKlVG6pLN2tD26wVxSqcHVsPv5p591rpVRsPnXHvtIUKJoPCOqjUNQxUSF4xekbybIPKGzBVUkJorkEZKM3yRUeVnkhz/HpmD6gLq535z+MCnfBLahNSX9Niba7pEb+DMmtpdIfiyn//YBHXbsoTbzKFeC0e1Su6Vj1WG6paTesaJ0sWDN2L19UlieGYu388qxq6clbVbvM5giqleOxvCpKCGM9mQ2X7Ci0PL+sfey2eWhN42GoPcZlUVO531DEZXJlp5hacbV+4xmNNZeLBMS2V9xyk3fzjjh8pEKGpdt4w3DqMF8UyRaO/O2YCwpjxm/0b6LjHP385Ew5X5G6WKZ0PxJUbFgnCQlOmSeCj1qTUTouqG50nW+2lCYk+juRqQZb5dRYakdf5MoXYw+Dr9Vt5/Z/Gm2vtygy1F9SWrcgDBicWdL+To5WuW6ralR3vrCo4Wa1LgcNa5DlV1BM5qNAX0cfj1vlW6EkjgWVEoLuSdc2iUIo3I4Y5TPW4zsIoBRMfgx8oatVotROVtfNsFoQFXdzVpfgKqUtIZTqzj73CDUzRstsp4jxShqyItmuE3jnel58z8Fon8+DcdDZCfW16IW6nq81tykp9K5t0nqmjxX6JtFlb18k0jXtuoS7etGm0y7NWlbaz6Xo7wV1ygvi/H6TymhfPny4TrC7vg22BYy8lx1Z1szsjhQYuaO+GhNMSi9x0kInqHSdSC4egYWQ9DF0NjXIOBZkuRE15zyl7bHQgDPIbA4hKC7gtUUw3onMnq8ZgRBD4Ok90ax9g4C0FcqwOD2P0Nx9yCtYQUrXBNx9EoRITBFFzKE4GraIK7/anGLNKaJlve8wiGoNHUPDcKPXy3c3XYuNK4hHHZJ96Q3Pzro03hwcHp8/f5gQE66B/3+YNDrR/FgcDwIoUHxyc/jfOpE9F6Pcwhzep0KihbsRpicCqEJ+1zFUaHCXKxbdVxdhbAMAV8Vuqa4iw/1s6RRymNkt3bdA4ykEKbTaSU5y9wv/Qphyd4l7IGGABjsMIPgEEMxzwyToZazA4JKUUFeLa6uygFoHsvx11pGPRwai0zkC4twaHXqFPPovmrD5L+4sFWJQ7hlUqXiyRxJiKJSGebrVNyZd4wzxUhiJViLz5QraWxxOqrixPg8/bFboI5qQDmTdo5Uv4pUJsnNjlOqX0PKmbRzpI6rSC1F+sBiKnYL1nENrNKqneN1UsWL3FCudgvWSQ0sZ9LbISXoI+Ox3l+qaBF5ef0SVKceVBrrd94M+jWA9bYC7NQHrG7Yr4ctyoTII+Qj13O7W+2rpJmSxac847L7zAgBvAf3ZIZ33z9f/OFQP10OdM3urjl6Jcuh0h+//L3U+4RVj0Ue6l6dKx/y/uzawNHfyHG8keNkI8fpRo5BnUMv3SY03m3I4mVW/QKqAYa15b3bWgMH+rBNdXNTgADcJyLAULssmSIprz9eVLy0HjRmZXuuOwNwmGeEY2d8mSmb/qYm9fDq6eQuDQghUCKjOLSGjnM7QwiuSSI1QTvlisj6Z9uT9dDm/i2N7pYp407Z8pZIarhiqhcuEcJKb/LT1eo/o2JThj8bAAA=";

const legacyDocument = defineDoc<{ items: string[] }>({
  kind: "test.migration",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "current",
  initial: () => ({ items: [] }),
  checkpointWhen: () => false,
});

function restoreLegacy(path: string) {
  const fixture = JSON.parse(gunzipSync(Buffer.from(legacyFixture, "base64")).toString()) as {
    schema: string[];
    tables: Record<string, Record<string, string | number | null>[]>;
  };
  const db = new DatabaseSync(path);
  try {
    for (const sql of fixture.schema) db.exec(sql);
    for (const [table, rows] of Object.entries(fixture.tables)) {
      for (const row of rows) {
        const columns = Object.keys(row);
        db.prepare(
          `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        ).run(...Object.values(row));
      }
    }
  } finally {
    db.close();
  }
  return fixture.tables;
}

function schemaVersion(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT version FROM durable_schema").get()?.version;
  } finally {
    db.close();
  }
}

function migrationTask(onDeliver: () => void = () => {}) {
  return defineTask<{ value: number }, { phase: "deliver" }, number>({
    name: "test.migration-task",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, ctx) => {
        onDeliver();
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: task.input.value },
          }),
          ctx,
        );
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
}

const legacyTaskId = 8 as TaskId<number>;

test("real schema-1 database migrates to schema 2 without rewriting documents or tasks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty-durable-migration-"));
  const path = join(directory, "legacy.sqlite");
  let harness: Harness | undefined;
  try {
    const before = restoreLegacy(path);
    expect(schemaVersion(path)).toBe(1);
    const storage = await openNodeSqliteStorage(path);
    try {
      expect(schemaVersion(path)).toBe(2);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        // The task table is rebuilt by migration 2; compare every persisted row,
        // including document bases/deltas and ID/commit-sequence metadata.
        for (const [table, rows] of Object.entries(before)) {
          if (table !== "durable_schema") {
            expect(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()).toEqual(rows);
          }
        }
      } finally {
        db.close();
      }
    } finally {
      await storage.close(context);
    }
    const registry = createRegistry();
    let delivered = 0;
    registry.install(
      defineExtension({ name: "migration-test", tasks: [migrationTask(() => delivered++)] }),
    );
    harness = await Harness.open(
      await openNodeSqliteStorage(path),
      { models: createModels(), registry },
      context,
    );
    const root = await harness.root(context);
    expect(root.id).toBe(1);
    expect(await harness.snapshot(legacyDocument, root.id, context)).toEqual({
      items: ["before migration", "second committed delta"],
    });
    expect(await harness.getTask(legacyTaskId, context)).toMatchObject({
      input: { value: 42 },
      background: true,
      state: { status: "pending", checkpoint: { phase: "deliver" } },
    });
    expect((await harness.waitForTask(legacyTaskId, context)).state).toEqual({
      status: "terminal",
      outcome: { status: "completed", result: 42 },
    });
    expect(delivered).toBe(1);
    await root.commit(async (tx) => {
      (await tx.doc(legacyDocument, root.id)).items.push("after migration");
    }, context);
    expect(await harness.snapshot(legacyDocument, root.id, context)).toEqual({
      items: ["before migration", "second committed delta", "after migration"],
    });
  } finally {
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("sleeping task persists its deadline and checkpoint, then resumes exactly once after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty-durable-sleep-"));
  const path = join(directory, "sleep.sqlite");
  let harness: Harness | undefined;
  let now = 1000;
  let starts = 0;
  let deliveries = 0;
  const sleeper = defineTask<{ at: number }, { phase: "wait" } | { phase: "deliver" }, null>({
    name: "test.sleeper",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: (task, runtime, ctx) => {
        starts++;
        return runtime.sleepUntil(task.input.at, { phase: "deliver" }, ctx);
      },
      deliver: (_task, runtime, ctx) => {
        deliveries++;
        return runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          ctx,
        );
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "sleep-test", tasks: [sleeper, migrationTask()] }));
  const open = async () =>
    Harness.open(
      await openNodeSqliteStorage(path),
      {
        models: createModels(),
        registry,
        now: () => now,
        onWake: () => {},
      },
      context,
    );
  try {
    // Exercise sleeping against the rebuilt legacy tasks table, not only a fresh schema 2.
    restoreLegacy(path);
    harness = await open();
    const root = await harness.root(context);
    const id = await root.commit(
      (tx) =>
        tx.createTask(
          sleeper,
          { at: 2000 },
          {
            ownership: { kind: "conversation" },
            background: true,
          },
        ),
      context,
    );
    harness.resume();
    await expect
      .poll(async () => (await harness!.getTask(id, context))?.state.status)
      .toBe("sleeping");
    await harness.waitForTask(legacyTaskId, context);
    expect(harness.wake()).toEqual({ active: false, at: 2000 });
    await harness.close(context);
    harness = await open();
    expect((await harness.getTask(id, context))?.state).toEqual({
      status: "sleeping",
      until: 2000,
      checkpoint: { phase: "deliver" },
    });
    harness.resume();
    expect(
      (await harness.inspect(context)).tasks.find((task) => task.record.id === id)?.state,
    ).toEqual({
      kind: "sleeping",
      until: 2000,
    });
    expect(starts).toBe(1);
    expect(deliveries).toBe(0);
    await harness.close(context);
    now = 2000;
    harness = await open();
    expect((await harness.waitForTask(id, context)).state).toEqual({
      status: "terminal",
      outcome: { status: "completed", result: null },
    });
    await harness.close(context);
    harness = await open();
    await harness.waitForTask(id, context);
    expect(starts).toBe(1);
    expect(deliveries).toBe(1);
    expect((await harness.inspect(context)).tasks).toEqual([]);
  } finally {
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a real process crash parks its running task at restart_limit and explicit retry recovers it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty-durable-crash-"));
  const path = join(directory, "crash.sqlite");
  let harness: Harness | undefined;
  try {
    restoreLegacy(path);
    const childPath = join(directory, "crash.mjs");
    const packageUrl = (name: string, file: string) =>
      new URL(`../../node_modules/@earendil-works/${name}/dist/${file}`, import.meta.url).href;
    await writeFile(
      childPath,
      `
      import { Harness, createRegistry, defineExtension, defineTask } from ${JSON.stringify(packageUrl("pi-durable", "index.js"))};
      import { openNodeSqliteStorage } from ${JSON.stringify(packageUrl("pi-durable", "storage/sqlite/node.js"))};
      import { createModels } from ${JSON.stringify(packageUrl("pi-ai", "models.js"))};
      import { BACKGROUND_CONTEXT as context } from ${JSON.stringify(packageUrl("chord", "context/index.js"))};
      const task = defineTask({ name: "test.migration-task", version: 1,
        initial: () => ({ phase: "deliver" }),
        phases: { deliver: async () => process.exit(73) }, abort: async () => {} });
      const registry = createRegistry();
      registry.install(defineExtension({ name: "crash-test", tasks: [task] }));
      const harness = await Harness.open(await openNodeSqliteStorage(${JSON.stringify(path)}), { models: createModels(), registry }, context);
      await harness.waitForTask(8, context);
    `,
    );
    const crashed = spawnSync(process.execPath, [childPath], { encoding: "utf8", timeout: 10_000 });
    expect(crashed.error, crashed.stderr).toBeUndefined();
    expect(crashed.status, crashed.stderr).toBe(73);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("SELECT status FROM tasks WHERE id = 8").get()?.status).toBe("running");
    } finally {
      db.close();
    }
    const registry = createRegistry();
    let executions = 0;
    registry.install(
      defineExtension({ name: "recovery-test", tasks: [migrationTask(() => executions++)] }),
    );
    const reports: { type: string; reason?: string }[] = [];
    harness = await Harness.open(
      await openNodeSqliteStorage(path),
      {
        models: createModels(),
        registry,
        settings: { restartLimit: 1 },
        onReport: (_error, info) => {
          reports.push(info);
        },
      },
      context,
    );
    expect(
      (await harness.inspect(context)).tasks.find((task) => task.record.id === legacyTaskId),
    ).toMatchObject({
      record: { restarts: 1 },
      state: { kind: "blocked", reason: "restart_limit" },
    });
    expect(harness.wake().active).toBe(false);
    expect(reports.filter((report) => report.type === "task_parked")).toHaveLength(1);
    expect(executions).toBe(0);
    await harness.retryTask(legacyTaskId, context);
    expect((await harness.waitForTask(legacyTaskId, context)).state).toEqual({
      status: "terminal",
      outcome: { status: "completed", result: 42 },
    });
    expect(executions).toBe(1);
  } finally {
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
