import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { entryMessages, historyPage } from "./runtime";
import { TranscriptImages } from "./transcript-images";

test("persisted assistant attempts expose the durable task identity without changing originals", () => {
  const entries = [
    {
      id: 1,
      conversationId: 1,
      kind: "pi.assistant",
      byTaskId: 7,
      model: [
        {
          role: "assistant",
          content: [{ type: "text", text: "**Partial" }],
          stopReason: "aborted",
          timestamp: 1,
        },
      ],
    },
    {
      id: 2,
      conversationId: 1,
      kind: "pi.assistant",
      byTaskId: 7,
      model: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Complete" }],
          stopReason: "stop",
          timestamp: 2,
        },
      ],
    },
  ] as unknown as Parameters<typeof entryMessages>[0];
  const original = JSON.stringify(entries);
  expect(entryMessages(entries)).toMatchObject([
    { id: "1", runTaskId: "7", stopReason: "aborted", blocks: [{ text: "**Partial" }] },
    { id: "2", runTaskId: "7", stopReason: "stop" },
  ]);
  expect(JSON.stringify(entries)).toBe(original);
});

test("delta history starts after its anchor and crosses invisible records and page boundaries", async () => {
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    const main = await harness.root(context);
    let anchor = "";
    await main.commit(async (tx) => {
      for (let i = 0; i < 300; i++) {
        const entry = await tx.appendEntry(main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `message ${i}`, timestamp: i }],
        });
        if (i === 20) anchor = String(entry.id);
        await tx.appendEntry(main.id, { kind: "bookkeeping", data: { i } });
      }
    }, context);
    const delta = await historyPage(storage, main.id, undefined, 120, anchor);
    expect(delta.messages).toHaveLength(279);
    expect(delta.messages[0]).toMatchObject({ blocks: [{ type: "text", text: "message 21" }] });
    expect(delta.messages.some((message) => message.id === anchor)).toBe(false);
    expect(delta.messages.at(-1)).toMatchObject({
      blocks: [{ type: "text", text: "message 299" }],
    });
  } finally {
    await harness.close(context);
  }
});

test.each(["/", "/batty"])(
  "inline images at %s leave history payloads, and previews retain originals",
  async (baseUrl) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-image-preview-"));
    const original = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const images = new TranscriptImages(directory, baseUrl);
    const messages = await images.messages([
      {
        id: "1",
        role: "user",
        timestamp: 1,
        blocks: [{ type: "image", mimeType: "image/png", data: original.toString("base64") }],
      },
    ]);
    const block = (messages[0] as any).blocks[0];
    expect(block.data).toBeUndefined();
    const prefix = baseUrl === "/" ? "" : baseUrl;
    expect(block.url).toMatch(new RegExp(`^${prefix}/api/transcript-images/[a-f0-9]{64}$`));
    expect(block.previewUrl).toBe(`${block.url}?preview=1`);
    const id = block.url.split("/").at(-1);
    const preview = await images.resolve(id, true);
    const originalFile = await images.resolve(id, false);
    expect(await fs.readFile(originalFile.path)).toEqual(original);
    expect(await sharp(preview.path).metadata()).toMatchObject({
      width: 768,
      height: 576,
      format: "webp",
    });
    expect(JSON.stringify(messages).length).toBeLessThan(1000);
    const again = await images.messages([
      {
        id: "2",
        role: "user",
        timestamp: 2,
        blocks: [{ type: "image", mimeType: "image/png", data: original.toString("base64") }],
      },
    ]);
    expect((again[0] as any).blocks[0].url).toBe(block.url);
    const invalid = await images.messages([
      {
        id: "3",
        role: "user",
        timestamp: 3,
        blocks: [
          {
            type: "image",
            mimeType: "image/png",
            data: Buffer.from("not an image").toString("base64"),
          },
        ],
      },
    ]);
    const invalidId = (invalid[0] as any).blocks[0].url.split("/").at(-1);
    await expect(images.resolve(invalidId, true)).rejects.toThrow();
    expect(await fs.readFile((await images.resolve(invalidId, false)).path, "utf8")).toBe(
      "not an image",
    );
    // Keep generated fixtures in the OS temp directory; no user files are affected.
  },
);
