import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { preparePromptFiles } from "./pi-service-uploads";

const roots: string[] = [];
async function createTempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "batty-upload-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("prompt uploads", () => {
  it("references uploaded text files without embedding their contents", async () => {
    const uploadsDir = await createTempDir();
    const content = Buffer.from('{"big":"json"}');
    const prepared = await preparePromptFiles(
      uploadsDir,
      "session-1",
      [{ filename: "data.json", data: content }],
      "/batty",
    );
    expect(prepared.images).toEqual([]);
    expect(prepared.uploadedImages).toEqual([]);
    expect(prepared.text).toContain('<file name="data.json"');
    expect(prepared.text).toContain('mimeType="application/json"');
    expect(prepared.text).toContain(`size="${content.length}"`);
    expect(prepared.text).toContain("/batty/api/uploads/session-1/");
    expect(prepared.text).not.toContain('{"big":"json"}');
  });

  it("stores colliding upload names independently", async () => {
    const uploadsDir = await createTempDir();
    const prepared = await preparePromptFiles(uploadsDir, "session-1", [
      { filename: "report?.txt", data: Buffer.from("first") },
      { filename: "report*.txt", data: Buffer.from("second") },
    ]);
    const [batchId] = await readdir(path.join(uploadsDir, "session-1"));
    const batchDir = path.join(uploadsDir, "session-1", batchId!);
    expect((await readdir(batchDir)).sort()).toEqual(["report--2.txt", "report-.txt"]);
    await expect(readFile(path.join(batchDir, "report-.txt"), "utf8")).resolves.toBe("first");
    await expect(readFile(path.join(batchDir, "report--2.txt"), "utf8")).resolves.toBe("second");
    expect(prepared.text).toContain("/report--2.txt");
  });

  it("keeps uploaded image payloads available for durable queue admission", async () => {
    const uploadsDir = await createTempDir();
    const data = Buffer.from("image-bytes");
    const prepared = await preparePromptFiles(
      uploadsDir,
      "session-1",
      [{ filename: "screenshot.png", data }],
      "/batty",
    );
    expect(prepared.images).toEqual([
      { type: "image", mimeType: "image/png", data: data.toString("base64") },
    ]);
    expect(prepared.text).toContain('name="screenshot.png"');
    expect(prepared.text).toContain("/batty/api/uploads/session-1/");
  });
});
