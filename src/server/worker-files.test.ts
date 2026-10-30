import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Multipart } from "@fastify/multipart";
import { expect, test } from "vite-plus/test";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, type ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { fixture, until } from "./orchestration-test-fixture";
import { artifactRefs } from "./artifact-forwarding";
import { decodeRuntimeNotice } from "./runtime-notices";
import { storeSentFiles } from "./send-files";
import {
  receiveWorkerFiles,
  encodeWorkerNotice,
  workerFileMetadata,
  type WorkerFileMetadata,
} from "./worker-files";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC",
  "base64",
);

function binaryParts(bytes: Buffer, name = "file-0"): AsyncIterable<Multipart> {
  return (async function* () {
    yield { type: "file", fieldname: name, file: Readable.from([bytes]) } as unknown as Multipart;
  })();
}
function manifest(bytes: Buffer): WorkerFileMetadata[] {
  return [
    {
      name: "evidence.txt",
      size: bytes.length,
      mimeType: "text/plain",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ];
}

test("file receipt verifies all bytes, rejects omissions/oversize/path traversal, and deduplicates concurrent/replayed imports", async () => {
  const { directory, open } = await fixture();
  await open();
  const storage = { rootDir: join(directory, "sent-files") };
  const bytes = Buffer.from("immutable evidence");
  const metadata = manifest(bytes);
  const [a, b] = await Promise.all([
    receiveWorkerFiles(storage, "node:a:request", metadata, binaryParts(bytes)),
    receiveWorkerFiles(storage, "node:a:request", metadata, binaryParts(bytes)),
  ]);
  expect(a).toEqual(b);
  expect(await readFile(a[0]!.file.storedPath)).toEqual(bytes);
  expect(workerFileMetadata(a)).toEqual(metadata);
  await expect(
    receiveWorkerFiles(
      storage,
      "node:a:request",
      manifest(Buffer.from("changed")),
      binaryParts(Buffer.from("changed")),
    ),
  ).rejects.toThrow("reused with different files");
  await expect(
    receiveWorkerFiles(
      storage,
      "bad-hash",
      metadata,
      binaryParts(Buffer.from("different evidence")),
    ),
  ).rejects.toThrow("integrity check failed");
  await expect(
    receiveWorkerFiles(storage, "missing", [...metadata, ...metadata], binaryParts(bytes)),
  ).rejects.toThrow("Missing worker file");
  await expect(
    receiveWorkerFiles(storage, "too-large", metadata, binaryParts(Buffer.alloc(100))),
  ).rejects.toThrow("size exceeds");
  await expect(
    receiveWorkerFiles(
      storage,
      "traversal",
      [{ ...metadata[0]!, name: "../outside" }],
      binaryParts(bytes),
    ),
  ).rejects.toThrow("Invalid worker file metadata");
  expect(
    (await readdir(storage.rootDir)).filter((name) => name.startsWith(".worker-input-")),
  ).toEqual([]);
  // A failed transfer has not claimed the durable request ID.
  const repaired = await receiveWorkerFiles(storage, "bad-hash", metadata, binaryParts(bytes));
  expect(await readFile(repaired[0]!.file.storedPath)).toEqual(bytes);
});

test("model-visible inputs convert BMP and bound large images while retaining originals, and reject invalid images", async () => {
  const { directory, open } = await fixture();
  await open();
  const storage = { rootDir: join(directory, "sent-files") };
  const bmp = Buffer.alloc(58);
  bmp.write("BM");
  bmp.writeUInt32LE(58, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(1, 18);
  bmp.writeInt32LE(1, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(4, 34);
  bmp[56] = 255;
  const large = await sharp(randomBytes(1200 * 1200 * 3), {
    raw: { width: 1200, height: 1200, channels: 3 },
  })
    .png()
    .toBuffer();
  expect(large.toString("base64").length).toBeGreaterThan(4.5 * 1024 * 1024);
  const wide = await sharp({ create: { width: 2100, height: 100, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  for (const [name, mimeType, bytes] of [
    ["pixel.bmp", "image/bmp", bmp],
    ["large.png", "image/png", large],
    ["wide.png", "image/png", wide],
  ] as const) {
    const metadata = [{ ...manifest(bytes)[0]!, name, mimeType }];
    const files = await receiveWorkerFiles(storage, name, metadata, binaryParts(bytes));
    const content = await encodeWorkerNotice(
      { kind: "subagent", text: "Inspect the image" },
      files,
    );
    if (!Array.isArray(content)) throw new Error("Expected native image content");
    const image = content.find((block) => block.type === "image")!;
    expect(["image/png", "image/jpeg", "image/webp", "image/gif"]).toContain(image.mimeType);
    expect(image.data.length).toBeLessThanOrEqual(4.5 * 1024 * 1024);
    const dimensions = await sharp(Buffer.from(image.data, "base64")).metadata();
    expect(dimensions.width).toBeLessThanOrEqual(2000);
    expect(dimensions.height).toBeLessThanOrEqual(2000);
    // Compare binary content directly instead of deeply traversing millions of bytes.
    expect((await readFile(files[0]!.file.storedPath)).equals(bytes)).toBe(true);
    if (name.endsWith("bmp")) expect(image.mimeType).toBe("image/png");
  }
  await expect(
    receiveWorkerFiles(
      storage,
      "invalid-image",
      [{ ...manifest(Buffer.from("not an image"))[0]!, name: "bad.png", mimeType: "image/png" }],
      binaryParts(Buffer.from("not an image")),
    ),
  ).rejects.toThrow("Cannot prepare image");
  const corrected = await receiveWorkerFiles(
    storage,
    "invalid-image",
    [{ ...manifest(png)[0]!, name: "bad.png", mimeType: "image/png" }],
    binaryParts(png),
  );
  expect(await readFile(corrected[0]!.file.storedPath)).toEqual(png);
  const correctedContent = await encodeWorkerNotice(
    { kind: "subagent", text: "Corrected upload" },
    corrected,
  );
  expect(
    Array.isArray(correctedContent) && correctedContent.some((block) => block.type === "image"),
  ).toBe(true);
}, 30_000);

test("local run/queue/steer/resume deliver immutable files and native image blocks, with retained history after restart", async () => {
  const { directory, faux, registry, orchestration, open } = await fixture();
  const textPath = join(directory, "evidence.txt");
  const imagePath = join(directory, "drawing.png");
  await writeFile(textPath, "first bytes");
  await writeFile(imagePath, png);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.install(
    defineExtension({
      name: "worker-files-hold",
      tools: [
        defineTool({
          name: "hold_file_assignment",
          description: "Hold the first assignment",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => {
            await gate;
            return { output: [{ type: "text", text: "released" }] };
          },
        }),
      ],
    }),
  );
  let { harness, main } = await open();
  await main.configure({ cwd: directory }, context);
  let id: string | undefined;
  let nextCommand: Record<string, JsonValue>;
  let parentSequence = 0;
  let pendingParent = "";
  const received: Array<{ phase: string; bytes: string; path: string; image: boolean }> = [];
  const responder: Parameters<typeof faux.setResponses>[0][number] = (request) => {
    const last = request.messages.findLast((message) => message.role !== "system")!;
    const text = JSON.stringify(last.content);
    if (
      pendingParent &&
      request.messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes(pendingParent),
      )
    ) {
      pendingParent = "";
      return fauxAssistantMessage([fauxToolCall("subagent", nextCommand)], {
        stopReason: "toolUse",
      });
    }
    if (last.role === "toolResult" && last.toolName === "subagent") {
      id ??= /Session ID: (\d+)/.exec(text)?.[1];
      return fauxAssistantMessage([fauxText("parent acknowledged")]);
    }
    if (last.role === "user") {
      const blocks =
        typeof last.content === "string"
          ? [{ type: "text" as const, text: last.content }]
          : last.content;
      const visible = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const phase = /phase-(run|queue|steer|resume)/.exec(visible)?.[1];
      if (phase) {
        const path = /path="([^"]+)"/.exec(visible)![1]!;
        received.push({
          phase,
          bytes: "",
          path,
          image: blocks.some(
            (block) => block.type === "image" && block.data === png.toString("base64"),
          ),
        });
        if (phase === "run")
          return fauxAssistantMessage([fauxToolCall("hold_file_assignment", {})], {
            stopReason: "toolUse",
          });
      }
    }
    return fauxAssistantMessage([fauxText("assignment complete")]);
  };
  const responses = () => faux.setResponses(Array.from({ length: 60 }, () => responder));
  responses();
  const send = async (action: string, phase: string, image = true) => {
    nextCommand = {
      action,
      ...(id ? { sessionId: id } : {}),
      prompt: `phase-${phase}`,
      files: [{ path: textPath }, ...(image ? [{ path: imagePath }] : [])],
    };
    pendingParent = `parent-command-${++parentSequence}`;
    await (await main.submit({ type: "input", content: pendingParent }, context)).wait(context);
    const result = (await main.context(context)).messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "subagent",
    );
    expect(result).toMatchObject({ isError: false });
  };
  try {
    await send("run", "run");
    await until(async () => received.some((item) => item.phase === "run"));
    await send("queue", "queue", false);
    await writeFile(textPath, "changed after queue");
    await send("steer", "steer");
    // Snapshot bytes are independent of their mutable workspace originals.
    await writeFile(textPath, "changed after steering");
    release();
    await until(async () => (await orchestration.listRunning()).length === 0);
    expect(received.map((item) => item.phase)).toEqual(["run", "steer", "queue"]);
    for (const item of received) item.bytes = await readFile(item.path, "utf8");
    expect(received.map(({ phase, bytes, image }) => ({ phase, bytes, image }))).toEqual([
      { phase: "run", bytes: "first bytes", image: true },
      { phase: "steer", bytes: "changed after queue", image: true },
      { phase: "queue", bytes: "first bytes", image: false },
    ]);
    await main.waitForIdle(context);
    await harness.close(context);
    ({ harness, main } = await open());
    responses();
    await send("resume", "resume");
    await until(async () => (await orchestration.listRunning()).length === 0);
    expect(received.at(-1)).toMatchObject({ phase: "resume", image: true });
    expect(await readFile(received.at(-1)!.path, "utf8")).toBe("changed after steering");
    const child = (await harness.conversation(Number(id) as ConversationId, context))!;
    const notices = (await child.context(context)).messages
      .filter((message) => message.role === "user")
      .map((message) => decodeRuntimeNotice(message.content));
    expect(notices.every((notice) => notice?.kind === "subagent")).toBe(true);
    expect(notices.at(-1)?.data?.inputFiles).toHaveLength(2);
  } finally {
    release();
  }
});

test("a caller can send a received file ref, but cannot invent refs or use files on lifecycle queries", async () => {
  const { directory, faux, registry, open, orchestration } = await fixture();
  const original = join(directory, "report.txt");
  await writeFile(original, "referenced attachment bytes");
  const [file] = await storeSentFiles({
    rootDir: join(directory, "sent-files"),
    workspaceId: "test",
    sessionId: "main",
    toolCallId: "seed",
    cwd: directory,
    paths: [original],
  });
  const ref = artifactRefs({ sentFiles: [file!] })[0]!.ref;
  registry.install(
    defineExtension({
      name: "worker-file-seed",
      tools: [
        defineTool({
          name: "seed_attachment",
          description: "Produce a file attachment",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => ({
            output: [{ type: "text", text: "file available" }],
            details: JSON.parse(JSON.stringify({ sentFiles: [file!] })),
          }),
        }),
      ],
    }),
  );
  const { main } = await open();
  await main.configure({ cwd: directory }, context);
  let deliveredPath: string | undefined;
  faux.setResponses(
    Array.from({ length: 30 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("make attachment"))
        return fauxAssistantMessage([fauxToolCall("seed_attachment", {})], {
          stopReason: "toolUse",
        });
      if (last.role === "user" && text.includes("send ref"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "run", prompt: "inspect ref", files: [{ ref }] })],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("invent ref"))
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "run",
              prompt: "invalid",
              files: [{ ref: "file:unknown" }],
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("files query"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "list", files: [{ path: original }] })],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("inspect ref"))
        deliveredPath = /path=\\"([^\\"]+)/.exec(text)?.[1];
      return fauxAssistantMessage([fauxText("done")]);
    }),
  );
  const send = async (content: string) => {
    await (await main.submit({ type: "input", content }, context)).wait(context);
  };
  await send("make attachment");
  await writeFile(original, "modified workspace source");
  await send("send ref");
  await until(async () => (await orchestration.listRunning()).length === 0);
  expect(await readFile(deliveredPath!, "utf8")).toBe("referenced attachment bytes");
  expect(deliveredPath).toContain("report.txt");
  for (const content of ["invent ref", "files query"]) {
    await send(content);
    const result = (await main.context(context)).messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "subagent",
    );
    expect(result).toMatchObject({ isError: true });
  }
});
