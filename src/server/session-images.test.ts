import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { SessionStore } from "./session-store";
import {
  createUiImageResolver,
  resolveSessionImage,
  sessionImageDirectory,
} from "./session-images";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("session image storage", () => {
  it("preserves inline images in native persistence and provider context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-session-images-"));
    roots.push(root);
    const store = await SessionStore.create(root, path.join(root, "sessions"));
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: Buffer.from("image bytes").toString("base64"),
    };
    await store.appendMessage({ role: "user", content: [image], timestamp: 1 });
    const file = store.getSessionFile();
    expect(await fs.readFile(file, "utf8")).toContain(image.data);
    store.release();
    const reopened = await SessionStore.open(file);
    expect(reopened.native.buildSessionContext().messages[0]).toMatchObject({ content: [image] });
    const resolve = createUiImageResolver(file, "workspace", reopened.getSessionId());
    const result = resolve(image);
    expect(await resolveSessionImage(file, result.name)).toMatchObject({ mimeType: "image/png" });
    expect(await fs.readFile(path.join(sessionImageDirectory(file), result.name), "utf8")).toBe(
      "image bytes",
    );
    reopened.release();
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
});
