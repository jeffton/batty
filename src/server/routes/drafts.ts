import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";

const uuidV4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const stagingPrefix = ".draft-put-";
const chunkBytes = 128 * 1024;

interface DraftFile {
  name: string;
  type: string;
  lastModified: number;
}

interface Draft {
  id: string;
  text: string;
  createdAt: number;
  files: DraftFile[];
  retryId?: string;
}

function badRequest(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function parseJsonField(value: string, error: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw badRequest(error);
  }
}

function isFileMetadata(value: unknown): value is Pick<DraftFile, "name" | "type"> {
  if (!value || typeof value !== "object") return false;
  return (
    "name" in value &&
    typeof value.name === "string" &&
    "type" in value &&
    typeof value.type === "string"
  );
}

async function stageDraft(request: FastifyRequest, directory: string, id: string): Promise<Draft> {
  // mkdtemp yields before the parser installs its disconnect listeners.
  if (request.raw.destroyed && !request.raw.readableEnded) {
    throw badRequest("Draft upload disconnected");
  }
  const fields = new Map<string, string>();
  const files: Omit<DraftFile, "lastModified">[] = [];
  let invalid = false;
  // Preserve display names as metadata only; names never become path segments.
  for await (const part of request.parts({
    preservePath: true,
    limits: { fieldSize: request.routeOptions.bodyLimit },
  })) {
    if (part.type === "file") {
      if (part.fieldname !== "file" || part.filename === undefined) {
        invalid = true;
        for await (const _chunk of part.file) {
          /* drain the multipart stream */
        }
        continue;
      }
      const filename = path.join(directory, String(files.length));
      await pipeline(part.file, createWriteStream(filename, { flags: "wx", mode: 0o600 }));
      if (part.file.truncated) throw new request.server.multipartErrors.RequestFileTooLargeError();
      files.push({ name: part.filename, type: part.mimetype });
    } else if (
      part.fieldnameTruncated ||
      part.valueTruncated ||
      typeof part.value !== "string" ||
      fields.has(part.fieldname) ||
      !["text", "createdAt", "lastModified", "retryId", "fileMetadata"].includes(part.fieldname)
    ) {
      invalid = true;
    } else {
      fields.set(part.fieldname, part.value);
    }
  }

  const text = fields.get("text");
  const rawCreatedAt = fields.get("createdAt");
  const createdAt = Number(rawCreatedAt);
  const retryId = fields.get("retryId");
  if (
    invalid ||
    text === undefined ||
    !rawCreatedAt?.trim() ||
    !Number.isFinite(createdAt) ||
    (retryId !== undefined && !uuid.test(retryId))
  ) {
    throw badRequest("Invalid draft fields");
  }
  const timestamps = parseJsonField(
    fields.get("lastModified") ?? "null",
    "Invalid draft file timestamps",
  );
  if (
    !Array.isArray(timestamps) ||
    timestamps.length !== files.length ||
    !timestamps.every(Number.isFinite)
  ) {
    throw badRequest("Invalid draft file timestamps");
  }

  const rawFileMetadata = fields.get("fileMetadata");
  let exactFiles = files;
  if (rawFileMetadata !== undefined) {
    const parsed = parseJsonField(rawFileMetadata, "Invalid draft file metadata");
    if (!Array.isArray(parsed) || parsed.length !== files.length || !parsed.every(isFileMetadata)) {
      throw badRequest("Invalid draft file metadata");
    }
    exactFiles = parsed;
  }
  return {
    id,
    // Browser FormData serializes textarea newlines as CRLF.
    text: text.replaceAll("\r\n", "\n"),
    createdAt,
    files: exactFiles.map(({ name, type }, index) => ({
      name,
      type,
      lastModified: timestamps[index] as number,
    })),
    ...(retryId !== undefined ? { retryId } : {}),
  };
}

/** Installation-local drafts. The app's global /api auth and no-store hook also applies here. */
export async function registerDraftRoutes(app: FastifyInstance, root: string, scope?: string) {
  // The runtime lock guarantees exclusive process ownership during recovery.
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    if (item.isDirectory() && item.name.startsWith(stagingPrefix)) {
      await fs.rm(path.join(root, item.name), { force: true, recursive: true });
    }
  }

  const suffix = scope ? `-${createHash("sha256").update(scope).digest("hex")}` : "";
  const databasePath = path.join(root, `drafts${suffix}.sqlite`);
  const db = new DatabaseSync(databasePath);
  app.addHook("onClose", async () => {
    await pendingWrite;
    db.close();
  });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, metadata TEXT) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS draft_chunks (
      id TEXT NOT NULL,
      file_index INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      bytes BLOB NOT NULL,
      PRIMARY KEY (id, file_index, chunk_index)
    ) WITHOUT ROWID;
  `);
  const listDb = new DatabaseSync(databasePath, { readOnly: true });
  app.addHook("onClose", async () => listDb.close());
  const list = listDb.prepare("SELECT metadata FROM drafts WHERE metadata IS NOT NULL");
  const findDraft = "SELECT metadata FROM drafts WHERE id = ? AND metadata IS NOT NULL";
  const insert = db.prepare(
    "INSERT INTO drafts (id, metadata) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
  );
  const insertChunk = db.prepare("INSERT INTO draft_chunks VALUES (?, ?, ?, ?)");
  const tombstone = db.prepare(
    "INSERT INTO drafts (id, metadata) VALUES (?, NULL) ON CONFLICT(id) DO UPDATE SET metadata = NULL",
  );
  const removeChunks = db.prepare("DELETE FROM draft_chunks WHERE id = ?");

  // A dedicated write connection serializes commits. The list and downloads
  // read committed snapshots while staging and chunk copying yield to the loop.
  let pendingWrite = Promise.resolve();
  function transaction(operation: () => void | Promise<void>) {
    const write = pendingWrite.then(async () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        await operation();
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
    pendingWrite = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  function publish(draft: Draft, staging: string) {
    return transaction(async () => {
      if (insert.run(draft.id, JSON.stringify(draft)).changes === 0) return;
      const buffer = Buffer.allocUnsafe(chunkBytes);
      for (let i = 0; i < draft.files.length; i++) {
        const file = await fs.open(path.join(staging, String(i)), "r");
        try {
          for (let j = 0; ; j++) {
            const { bytesRead } = await file.read(buffer);
            if (bytesRead === 0) break;
            insertChunk.run(draft.id, i, j, buffer.subarray(0, bytesRead));
          }
        } finally {
          await file.close();
        }
      }
    });
  }

  async function requireScope(request: FastifyRequest) {
    if (scope && request.headers["x-batty-draft-scope"] !== scope) {
      throw Object.assign(new Error("Draft owner changed"), { statusCode: 403 });
    }
  }

  app.get("/api/drafts", { preHandler: requireScope }, async () => ({
    drafts: list.all().map((row) => JSON.parse(row.metadata as string) as Draft),
  }));

  app.put<{ Params: { id: string } }>(
    "/api/drafts/:id",
    { preHandler: requireScope },
    async (request, reply) => {
      const { id } = request.params;
      if (!uuidV4.test(id)) throw badRequest("Invalid draft ID");
      const staging = await fs.mkdtemp(path.join(root, stagingPrefix));
      try {
        const draft = await stageDraft(request, staging, id).catch((error: unknown) => {
          // Busboy reports syntax errors through both the part iterator and file streams.
          if (
            error instanceof Error &&
            /^(Multipart: Boundary not found|Unexpected end of multipart data|Malformed part header|Part terminated early)$/.test(
              error.message,
            )
          ) {
            throw badRequest("Invalid draft multipart body");
          }
          throw error;
        });
        await publish(draft, staging);
      } finally {
        await fs.rm(staging, { force: true, recursive: true });
      }
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/drafts/:id",
    { preHandler: requireScope },
    async (request, reply) => {
      const { id } = request.params;
      if (!uuidV4.test(id)) throw badRequest("Invalid draft ID");
      await transaction(() => {
        tombstone.run(id);
        removeChunks.run(id);
      });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string; index: string } }>(
    "/api/drafts/:id/files/:index",
    { exposeHeadRoute: false, preHandler: requireScope },
    async (request, reply) => {
      const { id, index } = request.params;
      if (!uuidV4.test(id) || !/^(0|[1-9][0-9]*)$/.test(index)) {
        throw badRequest("Invalid draft file path");
      }
      // A reader has its own snapshot, so an in-flight download is complete
      // even if a concurrent DELETE hides the draft from subsequent requests.
      const reader = new DatabaseSync(databasePath, { readOnly: true });
      try {
        reader.exec("BEGIN");
        const row = reader.prepare(findDraft).get(id);
        const draft = row && (JSON.parse(row.metadata as string) as Draft);
        if (!draft?.files[Number(index)]) {
          reader.close();
          return reply.code(404).send({ error: "Draft file not found" });
        }
        const chunks = reader.prepare(
          "SELECT bytes FROM draft_chunks WHERE id = ? AND file_index = ? ORDER BY chunk_index",
        );
        const stream = Readable.from(
          (function* () {
            for (const chunk of chunks.iterate(id, Number(index))) yield chunk.bytes as Uint8Array;
          })(),
          { objectMode: false },
        );
        stream.once("close", () => reader.close());
        reply.raw.once("close", () => stream.destroy());
        return reply
          .header("Content-Disposition", "attachment")
          .header("X-Content-Type-Options", "nosniff")
          .type("application/octet-stream")
          .send(stream);
      } catch (error) {
        reader.close();
        throw error;
      }
    },
  );
}
