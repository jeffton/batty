import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import type { EntryRecord } from "@earendil-works/pi-durable";

// SQLite-specific read model. Triggers update in the same durable commit as the
// archive, so a crash cannot lose counts or require a full startup replay.
const visibleCount = `CASE WHEN json_array_length(json_extract(record, '$.model')) > 0 THEN
  (SELECT count(*) FROM json_each(json_extract(record, '$.model'))
    WHERE json_extract(value, '$.role') != 'system'
      AND json_extract(value, '$.display') IS NOT 0)
  WHEN json_type(record, '$.data.text') = 'text'
    OR (json_extract(record, '$.data.original.type') = 'custom_message'
      AND json_extract(record, '$.data.original.display') IS NOT 0) THEN 1 ELSE 0 END`;

export async function createHistoryIndex(db: SqliteDatabase) {
  await db.transaction(async (tx) => {
    const installed = await tx.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'batty_message_counts'",
    );
    if (!installed) {
      await tx.exec(`CREATE TABLE batty_entry_visibility (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, visible_count INTEGER NOT NULL) STRICT;
        INSERT INTO batty_entry_visibility SELECT id, conversation_id, ${visibleCount} FROM entries;
        CREATE INDEX batty_visible_history ON batty_entry_visibility (conversation_id, id DESC) WHERE visible_count > 0;
        CREATE TABLE batty_message_counts (conversation_id INTEGER PRIMARY KEY, count INTEGER NOT NULL) STRICT;
        INSERT INTO batty_message_counts SELECT conversation_id, sum(visible_count) FROM batty_entry_visibility GROUP BY conversation_id;
        CREATE TRIGGER batty_count_entry AFTER INSERT ON entries BEGIN
          INSERT INTO batty_entry_visibility SELECT id, conversation_id, ${visibleCount} FROM entries WHERE id = new.id;
          INSERT INTO batty_message_counts SELECT conversation_id, visible_count FROM batty_entry_visibility WHERE id = new.id
          ON CONFLICT(conversation_id) DO UPDATE SET count = count + excluded.count;
        END;`);
    }
    await tx.exec(
      "CREATE INDEX IF NOT EXISTS batty_submissions_by_entry ON submissions(conversation_id, json_extract(record, '$.entry'))",
    );
    await tx.exec(
      "CREATE INDEX IF NOT EXISTS batty_submissions_by_answer ON submissions(conversation_id, json_extract(record, '$.answer'))",
    );
  });
  return {
    async contextUsage(
      conversationId: number,
      model?: { provider: string; id: string; contextWindow: number },
    ) {
      // Read the latest request's provider measurement, independently of the
      // displayed history page. Never sum usage across turns or count cache hits
      // as free context: Pi normalizes input/cacheRead/cacheWrite as disjoint.
      const row = await db.get<{
        provider: string;
        model: string;
        stopReason: string;
        usage: string | null;
      }>(
        `SELECT json_extract(message.value, '$.provider') AS provider,
          json_extract(message.value, '$.model') AS model,
          json_extract(message.value, '$.stopReason') AS stopReason,
          json_extract(message.value, '$.usage') AS usage
         FROM (SELECT json_extract(e.record, '$.model') AS messages FROM entries e
           WHERE e.conversation_id = ? AND EXISTS (
             SELECT 1 FROM json_each(json_extract(e.record, '$.model')) candidate
             WHERE json_extract(candidate.value, '$.role') = 'assistant')
           ORDER BY e.id DESC LIMIT 1) latest, json_each(latest.messages) message
         WHERE json_extract(message.value, '$.role') = 'assistant'
         ORDER BY CAST(message.key AS INTEGER) DESC LIMIT 1`,
        conversationId,
      );
      const unknown = { contextTokens: null, contextPercent: null };
      if (
        !model ||
        !row?.usage ||
        row.provider !== model.provider ||
        row.model !== model.id ||
        ["error", "aborted", "deferred"].includes(row.stopReason)
      )
        return unknown;
      const usage = JSON.parse(row.usage) as {
        input: number;
        cacheRead: number;
        cacheWrite: number;
      };
      const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
      if (!(tokens > 0) || !(model.contextWindow > 0)) return unknown;
      return { contextTokens: tokens, contextPercent: (tokens / model.contextWindow) * 100 };
    },
    async responseArtifacts(conversationId: number, answerId: number) {
      const submission = await db.get<{ input: number | null }>(
        "SELECT MIN(json_extract(record, '$.entry')) AS input FROM submissions WHERE conversation_id = ? AND json_extract(record, '$.answer') = ?",
        conversationId,
        answerId,
      );
      if (submission?.input == null) return [];
      const rows = await db.all<{ record: string }>(
        `SELECT record FROM entries WHERE conversation_id = ? AND id >= ? AND id <= ?
          AND EXISTS (SELECT 1 FROM json_each(json_extract(record, '$.model')) AS message
            WHERE json_extract(message.value, '$.role') = 'toolResult' AND (
              json_type(message.value, '$.details.forwardedArtifacts') = 'object'
              OR EXISTS (SELECT 1 FROM json_each(json_extract(message.value, '$.details.sites')) AS site
                WHERE json_type(site.value, '$.browserId') = 'text')))
          ORDER BY id`,
        conversationId,
        submission.input,
        answerId,
      );
      return rows.map((row) => JSON.parse(row.record) as EntryRecord);
    },
    async entries(
      conversationId: number,
      before: string | undefined,
      limit: number,
      after?: string,
      maximum?: number,
    ) {
      const target = Math.min(limit, 500);
      const conditions = ["v.conversation_id = ?", "v.visible_count > 0"];
      const params: number[] = [conversationId];
      if (before !== undefined) {
        conditions.push("v.id < ?");
        params.push(Number(before.split(":")[0]));
      }
      if (after !== undefined) {
        conditions.push("v.id > ?");
        params.push(Number(after.split(":")[0]));
      }
      if (maximum !== undefined) {
        conditions.push("v.id <= ?");
        params.push(maximum);
      }
      const rows = await db.all<{ record: string }>(
        `SELECT e.record FROM batty_entry_visibility v JOIN entries e ON e.id = v.id WHERE ${conditions.join(" AND ")} ORDER BY v.id DESC LIMIT ?`,
        ...params,
        target + 1,
      );
      const entries = rows.slice(0, target).map((row) => JSON.parse(row.record) as EntryRecord);
      return {
        entries: entries.reverse(),
        hasMoreMessages: rows.length > target,
        nextBefore: entries[0] === undefined ? undefined : String(entries[0].id),
      };
    },
    async latestEntry(conversationId: number) {
      return (
        await db.get<{ id: number }>(
          "SELECT id FROM entries WHERE conversation_id = ? ORDER BY id DESC LIMIT 1",
          conversationId,
        )
      )?.id;
    },
    async nextBoundary(conversationId: number, after: string, limit: number) {
      const rows = await db.all<{ id: number }>(
        "SELECT id FROM entries WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT ?",
        conversationId,
        Number(after.split(":")[0]),
        limit + 1,
      );
      return { end: rows[Math.min(rows.length, limit) - 1]?.id, more: rows.length > limit };
    },
    async count(conversationId: number): Promise<number> {
      const row = await db.get<{ count: number }>(
        "SELECT count FROM batty_message_counts WHERE conversation_id = ?",
        conversationId,
      );
      return row?.count ?? 0;
    },
    async clientIds(
      conversationId: number,
      entryIds: readonly string[],
    ): Promise<Map<string, string>> {
      if (!entryIds.length) return new Map();
      const rows = await db.all<{ entry: number; requestId: string }>(
        `SELECT json_extract(record, '$.entry') AS entry, json_extract(record, '$.requestId') AS requestId
         FROM submissions WHERE conversation_id = ? AND json_extract(record, '$.entry') IN (${entryIds.map(() => "?").join(",")})`,
        conversationId,
        ...entryIds.map(Number),
      );
      return new Map(
        rows.filter((row) => row.requestId).map((row) => [String(row.entry), row.requestId]),
      );
    },
  };
}
