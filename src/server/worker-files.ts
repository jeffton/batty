import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Multipart } from "@fastify/multipart";
import type { SentFileDescriptor } from "../shared/types";
import { storeSentFiles } from "./send-files";
import { artifactRefs, artifactsFromModelMessages } from "./artifact-forwarding";
import type { WorkerCommandContext } from "./orchestration-workers";
import type { Context } from "@earendil-works/chord";
import type { UserMessage } from "@earendil-works/pi-ai";
import { encodeRuntimeNotice, type RuntimeNotice } from "./runtime-notices";
import {
  createReadToolDefinition,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

export type WorkerFileSource = { path: string } | { ref: string };
export type WorkerFileStorage = { rootDir: string; baseUrl?: string };
export type WorkerFileMetadata = { name: string; size: number; mimeType: string; sha256: string };
export type WorkerInputFile = WorkerFileMetadata & {
  file: SentFileDescriptor & { storedPath: string };
  modelImage?: { storedPath: string; mimeType: string; note: string };
};
export const MAX_WORKER_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 32;
const locks = new Map<string, Promise<unknown>>();
const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

function location(storage: WorkerFileStorage, key: string) {
  const batch = createHash("sha256").update(key).digest("hex");
  return {
    batch,
    receipt: path.join(storage.rootDir, "worker-inputs", "inputs", batch, "input.json"),
  };
}
async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}
async function existing(
  storage: WorkerFileStorage,
  key: string,
): Promise<WorkerInputFile[] | undefined> {
  try {
    return JSON.parse(await fs.readFile(location(storage, key).receipt, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}
export function workerFileMetadata(files: WorkerInputFile[]): WorkerFileMetadata[] {
  return files.map(({ name, size, mimeType, sha256 }) => ({ name, size, mimeType, sha256 }));
}
export function validateWorkerFileMetadata(value: unknown): asserts value is WorkerFileMetadata[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES)
    throw invalid(`files must contain between 1 and ${MAX_FILES} files`);
  let total = 0;
  for (const file of value) {
    if (
      !file ||
      typeof file.name !== "string" ||
      !file.name ||
      file.name === "." ||
      file.name === ".." ||
      /[/\\]/.test(file.name) ||
      [...file.name].some((character) => character.charCodeAt(0) < 32) ||
      typeof file.mimeType !== "string" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw invalid("Invalid worker file metadata");
    total += file.size;
  }
  if (total > MAX_WORKER_FILE_BYTES) throw invalid("Worker files exceed 100 MiB per message");
}
async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function save(
  storage: WorkerFileStorage,
  key: string,
  paths: string[],
  cwd: string,
  names?: string[],
  expected?: WorkerFileMetadata[],
): Promise<WorkerInputFile[]> {
  const { batch, receipt } = location(storage, key);
  try {
    const copied = await storeSentFiles({
      ...storage,
      workspaceId: "worker-inputs",
      sessionId: "inputs",
      toolCallId: batch,
      cwd,
      paths,
      names,
      reuseExisting: true,
    });
    const files: WorkerInputFile[] = [];
    for (const file of copied) {
      const input: WorkerInputFile = {
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        sha256: await digest(file.storedPath),
        file,
      };
      if (file.mimeType.startsWith("image/")) {
        // Use the same conversion/resize limits as read; preserve original attachment bytes.
        const result = await createReadToolDefinition(cwd).execute(
          "worker-input-image",
          {
            path: file.storedPath,
          },
          undefined,
          undefined,
          { cwd } as ExtensionToolContext,
        );
        const image = result.content.find((block) => block.type === "image");
        if (!image) throw invalid(`Cannot prepare image for the model: ${file.name}`);
        const storedPath = `${file.storedPath}.model-image`;
        await fs.writeFile(storedPath, Buffer.from(image.data, "base64"), { mode: 0o600 });
        input.modelImage = {
          storedPath,
          mimeType: image.mimeType,
          note: result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
        };
      }
      files.push(input);
    }
    validateWorkerFileMetadata(workerFileMetadata(files));
    if (expected && JSON.stringify(workerFileMetadata(files)) !== JSON.stringify(expected))
      throw new Error("Worker file metadata does not match stored files");
    const temporary = `${receipt}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(files), { mode: 0o600 });
    await fs.rename(temporary, receipt);
    return files;
  } catch (error) {
    // No input receipt exists yet: do not let an invalid image pin a rejected upload.
    await fs.rm(path.dirname(receipt), { recursive: true, force: true });
    throw error;
  }
}

/** Freeze selected bytes once per durable tool call, before queue admission or transport. */
export async function snapshotWorkerFiles(
  storage: WorkerFileStorage,
  sources: WorkerFileSource[],
  api: WorkerCommandContext,
  ctx: Context,
): Promise<WorkerInputFile[]> {
  const key = `tool:${api.conversationId}:${api.taskId}`;
  return serialized(location(storage, key).receipt, async () => {
    const ready = await existing(storage, key);
    if (ready) return ready;
    if (!sources.length || sources.length > MAX_FILES)
      throw new Error(`Select 1–${MAX_FILES} files`);
    const wanted = new Set(sources.flatMap((source) => ("ref" in source ? [source.ref] : [])));
    const refs = new Map<string, SentFileDescriptor & { storedPath?: string }>();
    if (wanted.size)
      await api.commit(async (tx) => {
        let cursor;
        do {
          const page = await tx.scanEntries({ conversationId: api.conversationId }, 200, cursor);
          for (const entry of page.items)
            for (const artifacts of artifactsFromModelMessages(entry.model ?? []))
              for (const item of artifactRefs(artifacts))
                if (item.kind === "file" && wanted.has(item.ref)) refs.set(item.ref, item.value);
          cursor = page.next;
        } while (cursor && refs.size < wanted.size);
      }, ctx);
    const paths = sources.map((source) => {
      if ("path" in source) return source.path;
      const file = refs.get(source.ref);
      if (!file?.storedPath)
        throw new Error(`File ref not available in this conversation: ${source.ref}`);
      return file.storedPath;
    });
    const cwd = (await api.agent(ctx)).cwd!;
    let total = 0;
    for (const source of paths) {
      const stat = await fs.stat(path.resolve(cwd, source));
      if (!stat.isFile()) throw new Error(`Path is not a file: ${source}`);
      total += stat.size;
    }
    if (total > MAX_WORKER_FILE_BYTES) throw new Error("Worker files exceed 100 MiB per message");
    const names = sources.map((source, index) =>
      "ref" in source ? refs.get(source.ref)!.name : path.basename(paths[index]!),
    );
    return save(storage, key, paths, cwd, names);
  });
}

/** Metadata comes first; binary parts are streamed, bounded and verified before admission. */
export async function receiveWorkerFiles(
  storage: WorkerFileStorage,
  key: string,
  metadata: WorkerFileMetadata[],
  parts: AsyncIterable<Multipart>,
): Promise<WorkerInputFile[]> {
  validateWorkerFileMetadata(metadata);
  await fs.mkdir(storage.rootDir, { recursive: true });
  const staging = await fs.mkdtemp(path.join(storage.rootDir, ".worker-input-"));
  const paths: string[] = [];
  let total = 0;
  try {
    for await (const part of parts) {
      const expected = metadata[paths.length];
      if (part.type !== "file" || !expected || part.fieldname !== `file-${paths.length}`)
        throw invalid("Unexpected worker file part");
      const directory = path.join(staging, String(paths.length));
      await fs.mkdir(directory);
      const target = path.join(directory, expected.name);
      let size = 0;
      const hash = createHash("sha256");
      await pipeline(
        part.file,
        new Transform({
          transform(chunk, _encoding, callback) {
            size += chunk.length;
            total += chunk.length;
            if (size > expected.size || total > MAX_WORKER_FILE_BYTES) {
              callback(invalid("Worker file size exceeds manifest or message limit"));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        }),
        createWriteStream(target, { mode: 0o600 }),
      );
      if (part.file.truncated || size !== expected.size || hash.digest("hex") !== expected.sha256)
        throw invalid(`Worker file integrity check failed: ${expected.name}`);
      paths.push(target);
    }
    if (paths.length !== metadata.length) throw invalid("Missing worker file parts");
    return await serialized(location(storage, key).receipt, async () => {
      const ready = await existing(storage, key);
      if (ready) {
        if (JSON.stringify(workerFileMetadata(ready)) !== JSON.stringify(metadata))
          throw invalid("Node requestId was reused with different files");
        return ready;
      }
      return save(storage, key, paths, staging, undefined, metadata);
    });
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function encodeWorkerNotice(
  notice: RuntimeNotice,
  files: WorkerInputFile[],
): Promise<UserMessage["content"]> {
  if (!files.length) return encodeRuntimeNotice(notice);
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const references = files
    .map(
      ({ file, modelImage }) =>
        `<file name="${escape(file.name)}" mimeType="${escape(file.mimeType)}" size="${file.size}" path="${escape(file.storedPath)}" url="${escape(file.downloadUrl)}"></file>${modelImage ? `\n${modelImage.note}` : ""}`,
    )
    .join("\n");
  const content: UserMessage["content"] = [
    {
      type: "text",
      text: encodeRuntimeNotice({
        ...notice,
        text: `${notice.text}\n\n${references}`,
        data: { ...notice.data, inputFiles: files.map(({ file }) => file) },
      }),
    },
  ];
  for (const input of files)
    if (input.modelImage)
      content.push({
        type: "image",
        mimeType: input.modelImage.mimeType,
        data: (await fs.readFile(input.modelImage.storedPath)).toString("base64"),
      });
  return content;
}

export async function workerCommandBody(
  command: unknown,
  requestId: string,
  files: WorkerInputFile[],
) {
  const body = new FormData();
  body.set("command", JSON.stringify({ requestId, command, files: workerFileMetadata(files) }));
  for (const [index, input] of files.entries())
    body.append(`file-${index}`, await openAsBlob(input.file.storedPath), input.name);
  return body;
}
