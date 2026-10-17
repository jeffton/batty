import { expect, test } from "vite-plus/test";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createHistoryIndex } from "./history-index";
import { forwardedResponseArtifacts } from "./artifact-forwarding";

test("response projection retains only explicitly selected metadata, scoped to its answered input", async () => {
  const db = await openNodeSqliteDatabase(":memory:");
  const storage = await SqliteStorage.open(db);
  try {
    const index = await createHistoryIndex(db);
    const selected = {
      fileChanges: [{ path: "a", patch: "saved diff" }],
      sites: [{ id: "s", name: "Chosen", url: "/s", public: false }],
    };
    const draft = {
      fileChanges: [{ path: "b", patch: "discarded" }],
      sites: [{ id: "draft", name: "Draft", url: "/draft", public: false }],
    };
    await db.transaction(async (tx) => {
      for (const [id, conversationId, details] of [
        [2, 1, { forwardedArtifacts: draft }],
        [4, 1, draft],
        [5, 1, { ...draft, forwardedArtifacts: selected }],
        [6, 2, { forwardedArtifacts: draft }],
      ] as const) {
        await tx.run(
          "INSERT INTO entries (id, conversation_id, commit_seq, record) VALUES (?, ?, 1, ?)",
          id,
          conversationId,
          JSON.stringify({
            id,
            conversationId,
            kind: "pi.tool",
            model: [{ role: "toolResult", details }],
          }),
        );
      }
      await tx.run(
        "INSERT INTO submissions VALUES (11, 1, ?, 'done', ?)",
        JSON.stringify("steer"),
        JSON.stringify({
          id: 11,
          conversationId: 1,
          type: "input",
          status: "done",
          entry: 6,
          answer: 7,
        }),
      );
      await tx.run(
        "INSERT INTO submissions VALUES (10, 1, ?, 'done', ?)",
        JSON.stringify("request"),
        JSON.stringify({
          id: 10,
          conversationId: 1,
          type: "input",
          status: "done",
          entry: 3,
          answer: 7,
        }),
      );
    });
    const entries = await index.responseArtifacts(1, 7);
    expect(entries.map((entry) => entry.id)).toEqual([5]);
    expect(forwardedResponseArtifacts(entries)).toEqual(selected);
    expect(await index.responseArtifacts(1, 8)).toEqual([]);
    expect(await index.responseArtifacts(2, 7)).toEqual([]);
    const plan = await db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT record FROM submissions WHERE conversation_id = 1 AND json_extract(record, '$.answer') = 7",
    );
    expect(plan.some((row) => row.detail.includes("batty_submissions_by_answer"))).toBe(true);
  } finally {
    await storage.close(context);
  }
});
