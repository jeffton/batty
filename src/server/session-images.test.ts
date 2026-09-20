import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BACKGROUND_CONTEXT, getOrThrow } from "@earendil-works/pi-agent-core";
import {
  createUiImageResolver,
  migrateSessionImages,
  resolveSessionImage,
  sessionImageDirectory,
  SessionImageFileSystem,
} from "./session-images";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("session image storage", () => {
  it("externalizes nested images and hydrates them for Pi reads", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-session-images-"));
    roots.push(root);
    const sessionFile = path.join(root, "session.jsonl");
    const imageData = Buffer.from("image bytes").toString("base64");
    const lines = [
      { v: 4, kind: "header", id: "session", storageVersion: 1, createdAt: 1, cwd: root },
      {
        kind: "entry",
        entry: {
          type: "compaction",
          retainedTail: [
            {
              role: "toolResult",
              content: [{ type: "image", mimeType: "image/png", data: imageData }],
            },
          ],
        },
      },
    ];
    await fs.writeFile(sessionFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    await migrateSessionImages(sessionFile);

    const stored = await fs.readFile(sessionFile, "utf8");
    expect(stored).toContain("batty-file:");
    expect(stored).not.toContain(imageData);
    const assetsDirectory = sessionImageDirectory(sessionFile);
    const assets = await fs.readdir(assetsDirectory);
    expect(assets).toHaveLength(1);
    await expect(fs.readFile(path.join(assetsDirectory, assets[0]!), "utf8")).resolves.toBe(
      "image bytes",
    );

    const env = new SessionImageFileSystem({ cwd: root });
    const hydrated = getOrThrow(await env.readTextFile(sessionFile, BACKGROUND_CONTEXT));
    expect(hydrated).toContain(imageData);
    expect(hydrated).not.toContain("batty-file:");

    const reader = getOrThrow(await env.openTextLineReader(sessionFile, BACKGROUND_CONTEXT));
    const header = getOrThrow(await reader.readLine(BACKGROUND_CONTEXT));
    const entry = getOrThrow(await reader.readLine(BACKGROUND_CONTEXT));
    await reader.close(BACKGROUND_CONTEXT);
    expect(header?.text).not.toContain(imageData);
    expect(entry?.text).toContain(imageData);
    expect(entry?.text).not.toContain("batty-file:");
  });

  it("externalizes images on append without changing the in-memory payload", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-session-images-"));
    roots.push(root);
    const sessionFile = path.join(root, "session.jsonl");
    const imageData = Buffer.from("tool image").toString("base64");
    const env = new SessionImageFileSystem({ cwd: root });
    const line = `${JSON.stringify({
      kind: "value",
      value: { type: "image", mimeType: "image/jpeg", data: imageData },
    })}\n`;

    await Promise.all([
      env.appendFile(sessionFile, line, BACKGROUND_CONTEXT).then(getOrThrow),
      env.appendFile(sessionFile, line, BACKGROUND_CONTEXT).then(getOrThrow),
    ]);

    const stored = await fs.readFile(sessionFile, "utf8");
    expect(stored).toContain("batty-file:");
    expect(stored).not.toContain(imageData);
    expect(line).toContain(imageData);
    const assets = await fs.readdir(sessionImageDirectory(sessionFile));
    expect(assets).toHaveLength(1);
    await expect(
      fs.readFile(path.join(sessionImageDirectory(sessionFile), assets[0]!), "utf8"),
    ).resolves.toBe("tool image");
  });

  it("uses session-owned images for UI presentation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-session-images-"));
    roots.push(root);
    const sessionFile = path.join(root, "session.jsonl");
    const image = { mimeType: "image/png", data: Buffer.from("image").toString("base64") };
    const resolve = createUiImageResolver(sessionFile, "workspace-1", "session-1", "/batty");

    const result = resolve(image);

    expect(result.url).toBe(`/batty/api/session-images/workspace-1/session-1/${result.name}`);
    expect(resolve(image)).toBe(result);
    await expect(resolveSessionImage(sessionFile, result.name)).resolves.toMatchObject({
      path: path.join(sessionImageDirectory(sessionFile), result.name),
      mimeType: "image/png",
    });
    await expect(
      fs.readFile(path.join(sessionImageDirectory(sessionFile), result.name), "utf8"),
    ).resolves.toBe("image");
  });

  it("migrates shared image files into session-owned directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-session-images-"));
    roots.push(root);
    const sessionFile = path.join(root, "session.jsonl");
    const name = `${"a".repeat(64)}.png`;
    await fs.mkdir(path.join(root, ".batty-images"));
    await fs.writeFile(path.join(root, ".batty-images", name), "legacy image");
    await fs.mkdir(sessionImageDirectory(sessionFile));
    await fs.writeFile(path.join(sessionImageDirectory(sessionFile), name), "partial");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ type: "image", mimeType: "image/png", data: `batty-file:${name}` })}\n`,
    );

    await migrateSessionImages(sessionFile);

    await expect(
      fs.readFile(path.join(sessionImageDirectory(sessionFile), name), "utf8"),
    ).resolves.toBe("legacy image");
  });
});
