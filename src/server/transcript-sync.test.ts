import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, test } from "vite-plus/test";
import { entryMessages } from "./runtime";
import { TranscriptImages } from "./transcript-images";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

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

test.each(["/", "/batty"])(
  "inline images at %s leave history payloads, and previews retain originals",
  async (baseUrl) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-image-preview-"));
    roots.push(directory);
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
  },
);
