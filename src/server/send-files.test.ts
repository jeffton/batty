import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { resolveSentFile, storeSentFiles } from "@/server/send-files";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("storeSentFiles", () => {
  it("copies files into Batty storage and returns preview/download urls", async () => {
    const cwd = await createTempDir("batty-send-files-cwd-");
    const rootDir = await createTempDir("batty-send-files-root-");

    await fs.writeFile(path.join(cwd, "chart.png"), "image-bytes", "utf8");
    await fs.writeFile(path.join(cwd, "clip.mp4"), "video-bytes", "utf8");
    await fs.writeFile(path.join(cwd, "notes.txt"), "hello world", "utf8");

    const sentFiles = await storeSentFiles({
      rootDir,
      baseUrl: "/batty",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      toolCallId: "tool-1",
      cwd,
      paths: ["chart.png", "clip.mp4", "notes.txt"],
    });

    expect(sentFiles).toHaveLength(3);
    expect(sentFiles[0]).toMatchObject({
      name: "chart.png",
      kind: "image",
      mimeType: "image/png",
      previewUrl: expect.stringContaining("/batty/api/sent-files/workspace-1/session-1/tool-1/"),
      downloadUrl: expect.stringContaining("?download=1"),
    });
    expect(sentFiles[1]).toMatchObject({
      name: "clip.mp4",
      kind: "video",
      mimeType: "video/mp4",
    });
    expect(sentFiles[2]).toMatchObject({
      name: "notes.txt",
      kind: "file",
      mimeType: "text/plain",
      previewUrl: undefined,
    });

    const resolved = await resolveSentFile({
      rootDir,
      baseUrl: "/batty",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      toolCallId: "tool-1",
      fileId: sentFiles[2]!.id,
    });
    expect(await fs.readFile(resolved.storedPath, "utf8")).toBe("hello world");
    expect(resolved.descriptor.downloadUrl).toContain(
      "/batty/api/sent-files/workspace-1/session-1/tool-1/",
    );
    expect(resolved.descriptor.downloadUrl).toContain("?download=1");
  });

  it("rejects directories", async () => {
    const cwd = await createTempDir("batty-send-files-cwd-");
    const rootDir = await createTempDir("batty-send-files-root-");
    await fs.mkdir(path.join(cwd, "folder"));

    await expect(
      storeSentFiles({
        rootDir,
        workspaceId: "workspace-1",
        sessionId: "session-1",
        toolCallId: "tool-1",
        cwd,
        paths: ["folder"],
      }),
    ).rejects.toThrow("Path is not a file: folder");
  });
});
