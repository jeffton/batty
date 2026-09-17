import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BACKGROUND_CONTEXT, getOrThrow } from "@earendil-works/pi-agent-core";
import { migrateSessionImages, SessionImageExecutionEnv } from "./session-images";

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
    const assets = await fs.readdir(path.join(root, ".batty-images"));
    expect(assets).toHaveLength(1);
    await expect(fs.readFile(path.join(root, ".batty-images", assets[0]!), "utf8")).resolves.toBe(
      "image bytes",
    );

    const env = new SessionImageExecutionEnv({ cwd: root });
    const hydrated = getOrThrow(await env.readTextFile(sessionFile, BACKGROUND_CONTEXT));
    expect(hydrated).toContain(imageData);
    expect(hydrated).not.toContain("batty-file:");
  });

  it("externalizes images on append without changing the in-memory payload", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-session-images-"));
    roots.push(root);
    const sessionFile = path.join(root, "session.jsonl");
    const imageData = Buffer.from("tool image").toString("base64");
    const env = new SessionImageExecutionEnv({ cwd: root });
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
    const assets = await fs.readdir(path.join(root, ".batty-images"));
    expect(assets).toHaveLength(1);
    await expect(fs.readFile(path.join(root, ".batty-images", assets[0]!), "utf8")).resolves.toBe(
      "tool image",
    );
  });
});
