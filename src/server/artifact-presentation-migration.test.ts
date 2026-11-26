import { expect, test } from "vite-plus/test";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createHistoryIndex } from "./history-index";
import {
  assertArtifactPresentationReady,
  markNewArtifactPresentationDatabase,
  migrateArtifactPresentation,
} from "./artifact-presentation-migration";
import { decodeRuntimeNotice, encodeRuntimeNotice } from "./runtime-notices";
import { openDiffContentSqliteDatabase } from "./diff-content-sqlite";

test("migration preserves response placement across conversations and pagination", async () => {
  const db = await openNodeSqliteDatabase(":memory:");
  const storage = await SqliteStorage.open(db);
  try {
    const index = await createHistoryIndex(db);
    const selected = {
      fileChanges: [{ path: "a", patch: "saved diff" }],
      sites: [
        { kind: "site" as const, id: "s", name: "Chosen", url: "/s", public: false as const },
      ],
      sentFiles: [
        {
          id: "video",
          name: "night.mp4",
          size: 42,
          mimeType: "video/mp4",
          kind: "video" as const,
          downloadUrl: "/video",
        },
      ],
    };
    const nativePhoto = {
      ...selected.sentFiles[0],
      id: "native-photo",
      name: "photo.png",
      mimeType: "image/png",
      kind: "image" as const,
    };
    const expected = { ...selected, sentFiles: [...selected.sentFiles, nativePhoto] };
    const draft = {
      sites: [
        {
          kind: "site" as const,
          id: "draft",
          name: "Draft",
          url: "/draft",
          public: false as const,
        },
      ],
    };
    const assistant = (text: string) => ({
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text }],
    });
    await db.transaction(async (tx) => {
      for (const [id, conversationId, model] of [
        [1, 1, [{ role: "toolResult", details: { forwardedArtifacts: draft } }]],
        [2, 1, [assistant("Earlier delivery")]],
        // A child report's inventory is not an attachment selection.
        [3, 1, [{ role: "toolResult", toolName: "subagent", details: draft }]],
        [
          4,
          1,
          [
            {
              role: "toolResult",
              toolName: "codemode",
              details: {
                calls: [
                  { name: "attach_artifacts", forwardedArtifacts: selected },
                  { name: "attach_files", sentFiles: [nativePhoto] },
                  { name: "subagent", sites: draft.sites },
                ],
              },
            },
          ],
        ],
        [5, 2, [{ role: "toolResult", details: { forwardedArtifacts: draft } }]],
        [
          6,
          1,
          [
            { role: "assistant", content: [{ type: "toolCall", name: "subagent" }] },
            { ...assistant("Hidden text"), display: false },
            assistant("\t\n\r\u00a0\u2009\ufeff "),
          ],
        ],
        [7, 1, [assistant("Here is the timelapse")]],
        [8, 1, [{ role: "user", content: "Another request" }]],
        [9, 1, [assistant("Unrelated final answer")]],
        [
          10,
          3,
          [{ role: "toolResult", toolName: "attach_files", details: { sentFiles: [nativePhoto] } }],
        ],
        [11, 3, [{ ...assistant(""), battySites: draft.sites }]],
        [12, 4, [{ role: "toolResult", toolName: "sites", details: draft }]],
      ] as const) {
        await tx.run(
          "INSERT INTO entries (id, conversation_id, commit_seq, record) VALUES (?, ?, 1, ?)",
          id,
          conversationId,
          JSON.stringify({ id, conversationId, kind: "pi.model", model }),
        );
      }
    });
    await expect(assertArtifactPresentationReady(db)).rejects.toThrow("migration required");
    await markNewArtifactPresentationDatabase(db);
    await expect(assertArtifactPresentationReady(db)).rejects.toThrow("migration required");
    const preview = await migrateArtifactPresentation(db, true);
    expect(preview).toMatchObject({
      replies: 3,
      files: 3,
      sites: 3,
      diffs: 1,
      terminalNativeGroups: 1,
    });
    await expect(assertArtifactPresentationReady(db)).rejects.toThrow("migration required");
    expect(await migrateArtifactPresentation(db)).toEqual(preview);
    expect(await migrateArtifactPresentation(db)).toEqual(preview);
    await assertArtifactPresentationReady(db);

    const page = await index.entries(1, "8", 1);
    expect(page.entries.map((entry) => entry.id)).toEqual([7]);
    expect(page.entries[0]?.model?.[0]).toEqual({
      ...assistant("Here is the timelapse"),
      battyPresentation: { ...expected, historical: true },
    });
    const [textless] = (await index.entries(3, undefined, 1)).entries;
    expect(textless?.model?.[0]).toMatchObject({
      battyPresentation: { ...draft, sentFiles: [nativePhoto], historical: true },
    });
    expect((await index.entries(4, undefined, 5)).entries).toHaveLength(1);
    expect((await index.entries(4, undefined, 5)).entries[0]?.model?.[0]).not.toHaveProperty(
      "battyPresentation",
    );
    const more = await index.entries(1, undefined, 20);
    const unattached = [6, 9].flatMap(
      (id) => more.entries.find((entry) => entry.id === id)?.model ?? [],
    );
    for (const message of unattached) expect(message).not.toHaveProperty("battyPresentation");
    expect(more.entries.find((entry) => entry.id === 2)?.model?.[0]).toMatchObject({
      battyPresentation: { ...draft, historical: true },
    });
    expect(more.entries.find((entry) => entry.id === 4)?.model?.[0]).toMatchObject({
      details: {
        calls: [
          { name: "attach_artifacts", forwardedArtifacts: selected },
          { name: "attach_files", sentFiles: [nativePhoto] },
          { name: "subagent", sites: draft.sites },
        ],
      },
    });
  } finally {
    await storage.close(context);
  }
});

test("preserves explicit and recovered notices, direct cron attachments, and packed diffs", async () => {
  const db = await openDiffContentSqliteDatabase(":memory:");
  const storage = await SqliteStorage.open(db);
  try {
    db.enableDiffContentWrites();
    const file = {
      id: "f",
      name: "clip",
      size: 1,
      mimeType: "video/mp4",
      kind: "video",
      downloadUrl: "/f",
    };
    const browser = { id: "b", name: "Browser", url: "/b", public: false, browserId: "original" };
    const patch = { path: "kept.ts", patch: "saved".repeat(100) };
    const embedded = {
      kind: "subagent" as const,
      text: "Done",
      data: {
        runtimeResultArtifacts: { sentFiles: [file], reportAttachments: { fileChanges: [patch] } },
      },
    };
    const old = {
      kind: "subagent" as const,
      text: "Done",
      data: { subagent: { sessionId: "42" }, runtimeNotice: { markdown: "Done" } },
    };
    const direct = {
      kind: "cron" as const,
      text: "Done",
      data: {
        cron: { sessionId: "42" },
        directDelivery: { text: "Done" },
        runtimeResultArtifacts: { sites: [browser] },
      },
    };
    const tool = {
      role: "toolResult",
      details: {
        sentFiles: [file],
        battyFileChanges: [{ path: "a.ts", before: "before\n", after: "after\n", order: 1 }],
      },
    };
    const assistant = { role: "assistant", content: [{ type: "text", text: "Done" }] };
    for (const [id, conversationId, message] of [
      [10, 42, { role: "user", content: "Task" }],
      [11, 42, tool],
      [12, 42, { role: "user", content: "Steering" }],
      [13, 42, assistant],
      [14, 42, { ...tool, details: { sentFiles: [{ ...file, id: "wrong" }] } }],
      [
        100,
        1,
        {
          role: "user",
          content: [
            { type: "text", text: encodeRuntimeNotice(embedded) },
            { type: "image", data: "opaque" },
          ],
        },
      ],
      [101, 1, { role: "user", content: encodeRuntimeNotice(old) }],
      [102, 1, { role: "user", content: encodeRuntimeNotice(direct) }],
      [103, 1, { ...assistant, content: [], battyFileChanges: [patch] }],
    ] as const) {
      await db.run(
        "INSERT INTO entries VALUES (?,?,NULL,1,?)",
        id,
        conversationId,
        JSON.stringify({ id, conversationId, model: [message] }),
      );
    }
    for (const [id, conversationId, requestId, entry, answer] of [
      [1000, 1, "batty-report:old", 101, 101],
      [1001, 42, "batty-deliver:old", 10, 13],
      [1002, 42, "batty-deliver:later", 14, 14],
      [1003, 1, "batty-report:later", 101, 101],
    ] as const) {
      await db.run(
        "INSERT INTO submissions VALUES (?,?,?,'done',?)",
        id,
        conversationId,
        JSON.stringify(requestId),
        JSON.stringify({
          id,
          conversationId,
          requestId,
          entry,
          answer,
          type: "input",
          status: "done",
        }),
      );
    }
    expect(await migrateArtifactPresentation(db)).toEqual({
      replies: 1,
      notices: 3,
      entries: 4,
      files: 1,
      sites: 0,
      browsers: 1,
      diffs: 3,
      unrecoveredNotices: 0,
      terminalNativeGroups: 0,
      uploadedInputs: 0,
      remoteFiles: 0,
      remoteNotices: 0,
    });
    const row = async (id: number) =>
      JSON.parse(
        (await db.get<{ record: string }>("SELECT record FROM entries WHERE id=?", id))!.record,
      ).model[0];
    const selected = await row(100);
    expect(selected.content[1]).toEqual({ type: "image", data: "opaque" });
    expect(decodeRuntimeNotice(selected.content)?.data).toEqual({
      ...embedded.data,
      runtimePresentation: { fileChanges: [patch], historical: true },
    });
    expect(decodeRuntimeNotice((await row(101)).content)?.data).toEqual({
      ...old.data,
      runtimePresentation: {
        sentFiles: [file],
        fileChanges: [{ path: "a.ts", patch: expect.stringContaining("-before\n+after") }],
        historical: true,
      },
    });
    expect(decodeRuntimeNotice((await row(102)).content)?.data).toEqual({
      ...direct.data,
      runtimePresentation: { sites: [{ ...browser, kind: "browser" }], historical: true },
    });
    expect(await row(103)).toEqual({
      ...assistant,
      content: [],
      battyFileChanges: [patch],
      battyPresentation: { fileChanges: [patch], historical: true },
    });
    expect(await row(11)).toEqual(tool);
    await assertArtifactPresentationReady(db);
  } finally {
    await storage.close(context);
  }
});

test("migration errors roll back all rows and the readiness marker", async () => {
  const db = await openNodeSqliteDatabase(":memory:");
  const storage = await SqliteStorage.open(db);
  try {
    const records = [1, 2].map((id) =>
      JSON.stringify({
        id,
        conversationId: 1,
        model: [
          { role: "assistant", content: [], battyFileChanges: [{ path: "a.ts", patch: "saved" }] },
        ],
      }),
    );
    for (const [index, record] of records.entries())
      await db.run("INSERT INTO entries VALUES (?,1,NULL,1,?)", index + 1, record);
    await db.exec(
      "CREATE TRIGGER migration_failure BEFORE UPDATE ON entries WHEN old.id=2 BEGIN SELECT raise(ABORT, 'test failure'); END",
    );
    await expect(migrateArtifactPresentation(db)).rejects.toThrow("test failure");
    await expect(assertArtifactPresentationReady(db)).rejects.toThrow("migration required");
    expect(await db.all("SELECT record FROM entries ORDER BY id")).toEqual(
      records.map((record) => ({ record })),
    );
  } finally {
    await storage.close(context);
  }
});

test("new databases get a marker and can reopen after admitting entries", async () => {
  const db = await openNodeSqliteDatabase(":memory:");
  const storage = await SqliteStorage.open(db);
  try {
    await markNewArtifactPresentationDatabase(db);
    const record = JSON.stringify({
      id: 1,
      conversationId: 1,
      model: [{ role: "assistant", content: [] }],
    });
    await db.run("INSERT INTO entries VALUES (1,1,NULL,1,?)", record);
    await assertArtifactPresentationReady(db);
    expect(await db.get("SELECT record FROM entries WHERE id=1")).toEqual({ record });
  } finally {
    await storage.close(context);
  }
});
