import { writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  externalizeInlineImagesInSession,
  externalizeUploadedImagesInSession,
  preparePromptFiles,
} from "./pi-service-uploads";

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("prompt uploads", () => {
  it("imports and externalizes existing inline image data", async () => {
    const uploadsDir = await createTempDir("batty-inline-images-");
    const imageData = Buffer.from("old-image").toString("base64");
    const message = {
      role: "user",
      timestamp: 1,
      content: [{ type: "image", mimeType: "image/png", data: imageData }],
    };
    const entry = { type: "message", message };
    const sessionFile = path.join(uploadsDir, "session.jsonl");
    const manager = {
      fileEntries: [{ type: "session", id: "session-1" }, entry],
      _rewriteFile: () => {
        writeFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
      },
    };
    const session = {
      sessionId: "session-1",
      messages: [message],
      sessionManager: manager,
    } as never;

    externalizeInlineImagesInSession(session, uploadsDir, "/batty");

    expect(JSON.stringify(message)).not.toContain(imageData);
    expect((message as { battyAttachments?: unknown }).battyAttachments).toEqual([
      {
        kind: "image",
        name: expect.stringMatching(/^[a-f0-9]{64}\.png$/),
        mimeType: "image/png",
        size: Buffer.from("old-image").length,
        url: expect.stringContaining("/batty/api/uploads/session-1/imported/"),
      },
    ]);
    expect(await readFile(sessionFile, "utf8")).not.toContain(imageData);
  });

  it("externalizes uploaded image data from session messages", async () => {
    const uploadsDir = await createTempDir("batty-upload-images-");
    const data = Buffer.from("image-bytes");
    const prepared = await preparePromptFiles(
      uploadsDir,
      "session-1",
      [{ filename: "screenshot.png", data }],
      "/batty",
    );
    const imageData = prepared.images[0]?.data;
    const message = {
      role: "user",
      timestamp: 1,
      content: [
        { type: "text", text: "Look at this" },
        { type: "image", mimeType: "image/png", data: imageData },
      ],
    };
    const entry = { type: "message", message };
    const sessionFile = path.join(uploadsDir, "session.jsonl");
    const manager = {
      fileEntries: [{ type: "session", id: "session-1" }, entry],
      _rewriteFile: () => {
        writeFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
      },
    };
    const session = {
      messages: [message],
      sessionManager: manager,
    } as never;

    externalizeUploadedImagesInSession(session, prepared.uploadedImages);

    expect(message.content).toEqual([
      { type: "text", text: "Look at this" },
      { type: "text", text: "[Image attachment: screenshot.png]" },
    ]);
    expect((message as { battyAttachments?: unknown }).battyAttachments).toEqual([
      {
        kind: "image",
        name: "screenshot.png",
        mimeType: "image/png",
        size: data.length,
        url: expect.stringContaining("/batty/api/uploads/session-1/"),
      },
    ]);
    expect(JSON.stringify(message)).not.toContain(imageData);
    expect(await readFile(sessionFile, "utf8")).not.toContain(imageData!);
  });
});
