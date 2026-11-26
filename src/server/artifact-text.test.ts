import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import fastify from "fastify";
import { expect, test } from "vite-plus/test";
import { sendArtifactText } from "./artifact-text";
import { INLINE_TEXT_MAX_BYTES } from "./text-output-limits";

const metadata = (name: string) => ({ name, mimeType: "application/octet-stream" });

test("previews only a bounded UTF-8 prefix without a partial multibyte character", async ({
  onTestFinished,
}) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "batty-text-"));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "long.log");
  const line = "a".repeat(INLINE_TEXT_MAX_BYTES - 1);
  const original = `${line}🌊\nsecond line`;
  await fs.writeFile(file, original);
  const app = fastify();
  onTestFinished(() => app.close());
  app.get("/preview", (_request, reply) => sendArtifactText(reply, metadata("long.log"), file));
  const preview = await app.inject("/preview");
  expect(preview.statusCode).toBe(200);
  expect(preview.headers["x-batty-preview-truncated"]).toBe("1");
  expect(preview.body).toBe(line);
  expect(await fs.readFile(file, "utf8")).toBe(original);

  await fs.writeFile(file, "x".repeat(INLINE_TEXT_MAX_BYTES));
  const exact = await app.inject("/preview");
  expect(exact.headers["x-batty-preview-truncated"]).toBeUndefined();
  expect(exact.body).toHaveLength(INLINE_TEXT_MAX_BYTES);
});

test("the preview rejects binary data under a text-looking name", async ({ onTestFinished }) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "batty-text-"));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "transport.ts");
  const descriptor = {
    ...metadata("transport.ts"),
    id: "transport",
    size: 3,
    kind: "file" as const,
    downloadUrl: "/download",
  };
  const app = fastify();
  onTestFinished(() => app.close());
  app.get("/preview", (_request, reply) => sendArtifactText(reply, descriptor, file));
  for (const bytes of [Buffer.from([65, 0, 66]), Buffer.from([0xff, 65, 66])]) {
    await fs.writeFile(file, bytes);
    expect((await app.inject("/preview")).statusCode).toBe(415);
  }
});
