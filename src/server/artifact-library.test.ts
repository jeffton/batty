import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import fastify from "fastify";
import cookie from "@fastify/cookie";
import sharp from "sharp";
import { expect, test } from "vite-plus/test";
import type { ArtifactLibraryResponse } from "@/shared/artifact-library";
import { fileLibraryRef, siteLibraryRef } from "@/shared/artifact-library";
import { ArtifactLibrary } from "./artifact-library";
import { createAuthToken } from "./auth";
import { stateDirPath } from "./options";
import { normalizeMessage } from "./pi-state";
import { registerApiAuth } from "./routes/api-auth";
import { registerArtifactRoutes } from "./routes/artifacts";
import { NODE_EXPORTS_WORKSPACE, storeSentFiles } from "./send-files";
import { createSite, setSitePublic } from "./sites";
import { imagePreview } from "./transcript-images";
import { preparePromptFiles, resolveUploadedFile, uploadedPreviewPath } from "./uploads";

async function fixture() {
  const battyDir = await fs.mkdtemp(path.join(tmpdir(), "batty-artifact-library-"));
  const root = stateDirPath(battyDir);
  return {
    battyDir,
    sentFilesDir: path.join(root, "sent-files"),
    uploadsDir: path.join(root, "uploads"),
    sitesDir: path.join(root, "sites"),
    baseUrl: "/batty/" as const,
  };
}

test("projects committed file snapshots, legacy uploads and living local sites", async () => {
  const config = await fixture();
  try {
    const { battyDir, sentFilesDir, uploadsDir, sitesDir, baseUrl } = config;
    const original = path.join(battyDir, "artifact.txt");
    await fs.writeFile(original, "generated");
    const sent = {
      rootDir: sentFilesDir,
      workspaceId: "workspace:1",
      sessionId: "1",
      toolCallId: "call-1",
      cwd: battyDir,
      paths: [original],
    };
    const [file] = await storeSentFiles(sent);
    const privateCopies = await Promise.all([
      storeSentFiles({ ...sent, workspaceId: NODE_EXPORTS_WORKSPACE }),
      storeSentFiles({ ...sent, workspaceId: "worker-inputs", sessionId: "inputs" }),
    ]);
    await fs.unlink(original);
    const pendingCall = path.join(sentFilesDir, "workspace-1", "1", "call-2");
    await fs.mkdir(pendingCall, { recursive: true });
    await fs.writeFile(path.join(pendingCall, "copied.txt"), "uncommitted");

    const batch = path.join(uploadsDir, "1", "legacy-batch");
    await fs.mkdir(batch, { recursive: true });
    const legacyUpload = path.join(batch, "document.pdf");
    await fs.writeFile(legacyUpload, "incoming");
    await fs.utimes(legacyUpload, new Date("2020-01-01"), new Date("2020-01-01"));
    await fs.symlink(original, path.join(batch, "external.txt"), "file");

    const hiddenUpload = path.join(uploadsDir, "1", ".pending");
    await fs.mkdir(hiddenUpload);
    await fs.writeFile(path.join(hiddenUpload, "partial.txt"), "partial");
    const prepared = await preparePromptFiles(
      uploadsDir,
      "1",
      [{ filename: "notes.txt", data: Buffer.from("attached") }],
      baseUrl,
    );
    const live = await createSite(sitesDir, baseUrl, "Live site");
    const library = new ArtifactLibrary(config);
    const items = await library.list();
    expect(items.map(({ title }) => title).sort()).toEqual([
      "Live site",
      "artifact.txt",
      "document.pdf",
      "notes.txt",
    ]);
    expect(items.at(-1)).toMatchObject({
      source: "upload",
      file: {
        mimeType: "application/pdf",
        downloadUrl: "/batty/api/uploads/1/legacy-batch/document.pdf?download=1",
      },
    });
    expect(items.find(({ ref }) => ref === fileLibraryRef(file!.id))).toMatchObject({
      source: "generated",
      file: { downloadUrl: expect.stringMatching(/^\/batty\/api\/sent-files\/workspace-1\//) },
    });
    expect(JSON.stringify(items)).not.toContain(battyDir);
    expect(JSON.stringify(items)).not.toContain("site-preview");
    const note = items.find(({ title }) => title === "notes.txt");
    expect(note?.kind).toBe("file");
    if (note?.kind !== "file") throw new Error("Missing uploaded note");
    const url = new URL(note.file.downloadUrl, "https://batty.test");
    const [session, batchId, filename] = url.pathname.split("/").slice(-3);
    const stored = await resolveUploadedFile(uploadsDir, session!, batchId!, filename!);
    expect(prepared.text).toContain(stored.path);
    expect(prepared.text).toContain(`artifactRef="${note.ref}"`);
    expect(
      normalizeMessage({ role: "user", content: prepared.text, timestamp: 1 }, 0),
    ).toMatchObject({
      blocks: [{ type: "attachment", file: { downloadUrl: url.pathname } }],
    });
    expect(await library.resolveFileSource(note.ref)).toEqual({
      name: "notes.txt",
      path: stored.path,
    });
    const originalCopy = await library.resolveFileSource(fileLibraryRef(file!.id));
    expect(await fs.readFile(originalCopy.path, "utf8")).toBe("generated");
    for (const [copy] of privateCopies) {
      await expect(library.resolveFileSource(fileLibraryRef(copy!.id))).rejects.toMatchObject({
        statusCode: 404,
      });
    }
    await expect(library.resolveFileSource("file:")).rejects.toMatchObject({ statusCode: 404 });
    expect(await fs.readFile(stored.path, "utf8")).toBe("attached");

    const siteRef = siteLibraryRef(live.descriptor.id);
    await setSitePublic(sitesDir, baseUrl, live.descriptor.id, true);
    const [site, fromUpload] = await library.resolve([siteRef, note.ref, siteRef]);
    expect(site).toMatchObject({ kind: "site", ref: siteRef, site: { public: true } });
    expect(fromUpload).toEqual(note);
    await expect(library.resolve([siteRef, "browser:unknown"])).rejects.toMatchObject({
      statusCode: 404,
    });
  } finally {
    await fs.rm(config.battyDir, { recursive: true, force: true });
  }
});

test("new preview caches are not artifacts and ambiguous legacy filenames are preserved", async () => {
  const config = await fixture();
  try {
    const source = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const userWebp = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "blue" },
    })
      .webp()
      .toBuffer();
    const batch = path.join(config.uploadsDir, "1", "legacy-batch");
    await fs.mkdir(batch, { recursive: true });
    const original = path.join(batch, "legacy.png");
    await fs.writeFile(original, source);
    const generated = await imagePreview(original);
    await fs.writeFile(path.join(batch, "real.png"), source);
    await fs.writeFile(path.join(batch, "real.png.preview.webp"), userWebp);
    await preparePromptFiles(config.uploadsDir, "1", [
      { filename: "new.png", data: source },
      { filename: "new.png.preview.webp", data: generated },
    ]);
    const target = uploadedPreviewPath(config.uploadsDir, original);
    expect(await imagePreview(original, target)).toEqual(generated);

    const rows = await new ArtifactLibrary(config).list();
    expect(rows.map(({ title }) => title).sort()).toEqual([
      "legacy.png",
      "legacy.png.preview.webp",
      "new.png",
      "new.png.preview.webp",
      "real.png",
      "real.png.preview.webp",
    ]);
    expect(rows.find(({ title }) => title === "legacy.png")).toMatchObject({
      file: { previewUrl: "/batty/api/uploads/1/legacy-batch/legacy.png" },
    });
  } finally {
    await fs.rm(config.battyDir, { recursive: true, force: true });
  }
});

test("routes persist concurrent star changes, prefer starred rows and reject unknown refs", async () => {
  const config = await fixture();
  const app = fastify();
  try {
    const first = await createSite(config.sitesDir, config.baseUrl, "First");
    const newer = await createSite(config.sitesDir, config.baseUrl, "Newer");
    const batch = path.join(config.uploadsDir, "1", "batch");
    await fs.mkdir(batch, { recursive: true });
    const newest = path.join(batch, "New.txt");
    await fs.writeFile(newest, "attach");
    await fs.utimes(newest, new Date("2090-01-01"), new Date("2090-01-01"));
    await app.register(cookie);
    const auth = { cookieName: "batty_test", authSecret: "test-signing-secret" };
    registerApiAuth(app, auth, () => undefined);
    registerArtifactRoutes(app, new ArtifactLibrary(config));

    const url = "/api/artifacts/star";
    const headers = { cookie: `${auth.cookieName}=${createAuthToken(auth.authSecret)}` };
    const unauthorized = await app.inject("/api/artifacts");
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["cache-control"]).toBe("no-store");
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          payload: { ref: siteLibraryRef(first.descriptor.id), starred: true },
        })
      ).statusCode,
    ).toBe(401);
    const catalog = await app.inject({ url: "/api/artifacts", headers });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.headers["cache-control"]).toBe("no-store");
    const firstRef = siteLibraryRef(first.descriptor.id);
    const newerRef = siteLibraryRef(newer.descriptor.id);
    expect(catalog.json<ArtifactLibraryResponse>().artifacts[0]?.title).toBe("New.txt");

    const marked = await Promise.all(
      [firstRef, newerRef].map((ref) =>
        app.inject({ method: "PUT", url, headers, payload: { ref, starred: true } }),
      ),
    );
    for (const response of marked) expect(response.statusCode).toBe(200);
    const restarted = new ArtifactLibrary(config);
    const rows = await restarted.list();
    expect(new Set(rows.slice(0, 2).map(({ ref }) => ref))).toEqual(new Set([firstRef, newerRef]));
    expect(rows.map(({ starred }) => starred)).toEqual([true, true, false]);

    const unknown = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: { ref: "site:not-local", starred: true },
    });
    expect(unknown.statusCode).toBe(404);
    const invalid = await app.inject({ method: "PUT", url, headers, payload: { ref: firstRef } });
    expect(invalid.statusCode).toBe(400);
    const unmarked = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: { ref: firstRef, starred: false },
    });
    expect(unmarked.json<ArtifactLibraryResponse>().artifacts.map(({ title }) => title)).toEqual([
      "Newer",
      "New.txt",
      "First",
    ]);
  } finally {
    await app.close();
    await fs.rm(config.battyDir, { recursive: true, force: true });
  }
});
