import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createSite, deleteSite, getSite, resolveSiteFile, setSitePublic } from "./sites";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-sites-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("sites", () => {
  it("allocates a mutable site directory and resolves its files", async () => {
    const root = await tempDir();
    const created = await createSite(root, "/batty", "Demo");
    await fs.writeFile(path.join(created.directory, "index.html"), "<h1>Hello</h1>", "utf8");
    await fs.mkdir(path.join(created.directory, "assets"));
    await fs.writeFile(path.join(created.directory, "assets", "app.js"), "alert(1)", "utf8");

    expect(created.descriptor).toMatchObject({ name: "Demo", public: false });
    expect(created.descriptor.url).toBe(`/batty/sites/${created.descriptor.id}/`);
    expect(created.browserUrl).toContain(`/batty/site-preview/${created.descriptor.id}/`);
    await expect(getSite(root, "/batty", created.descriptor.id)).resolves.toMatchObject({
      directory: created.directory,
    });
    await expect(resolveSiteFile(root, "/batty", created.descriptor.id, "")).resolves.toMatchObject(
      {
        filePath: path.join(created.directory, "index.html"),
        mimeType: "text/html",
      },
    );
    await expect(
      resolveSiteFile(root, "/batty", created.descriptor.id, "assets/app.js"),
    ).resolves.toMatchObject({ mimeType: "text/javascript" });
  });

  it("persists public state and deletes sites", async () => {
    const root = await tempDir();
    const created = await createSite(root, "/", "Demo");
    await expect(setSitePublic(root, "/", created.descriptor.id, true)).resolves.toMatchObject({
      public: true,
    });
    await deleteSite(root, created.descriptor.id);
    await expect(getSite(root, "/", created.descriptor.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("rejects traversal and symlink escapes", async () => {
    const root = await tempDir();
    const created = await createSite(root, "/", "Demo");
    const outside = path.join(root, "secret.txt");
    await fs.writeFile(outside, "secret", "utf8");
    await fs.symlink(outside, path.join(created.directory, "escape.txt"));

    await expect(
      resolveSiteFile(root, "/", created.descriptor.id, "../manifest.json"),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      resolveSiteFile(root, "/", created.descriptor.id, "%2e%2e%2fmanifest.json"),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      resolveSiteFile(root, "/", created.descriptor.id, "escape.txt"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
