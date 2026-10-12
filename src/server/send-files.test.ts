import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { createAttachFilesTool } from "./custom-tools";
import { resolveSentFile, storeSentFiles } from "./send-files";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "batty-attachment-replay-"));
  const source = path.join(dir, "artifact.txt");
  await writeFile(source, "original artifact");
  const options = {
    rootDir: path.join(dir, "sent"),
    cwd: dir,
    workspaceId: "project",
    sessionId: "123",
    toolCallId: "call-1",
    paths: [source],
    reuseExisting: true,
  };
  return { dir, source, options };
}

test("attach_files replay returns the same result after its source is removed", async () => {
  const { dir, source, options } = await fixture();
  try {
    const tool = createAttachFilesTool({
      workspace: { id: options.workspaceId, path: dir },
      config: { sentFilesDir: options.rootDir },
    } as never);
    const context = { sessionManager: { getSessionFile: () => "123.jsonl" } } as never;
    const first = await tool.execute(
      options.toolCallId,
      { paths: [source] },
      undefined,
      undefined,
      context,
    );
    await rm(source);
    const replay = await tool.execute(
      options.toolCallId,
      { paths: [source] },
      undefined,
      undefined,
      context,
    );
    expect(replay).toEqual(first);
    const [file] = (replay.details as { sentFiles: { id: string; storedPath: string }[] })
      .sentFiles;
    const resolved = await resolveSentFile({ ...options, fileId: file!.id });
    expect(resolved.storedPath).toBe(file!.storedPath);
    expect(await readFile(resolved.storedPath, "utf8")).toBe("original artifact");
    expect(await readdir(path.dirname(resolved.storedPath))).toEqual([
      "01-artifact.txt",
      "manifest.json",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an interrupted copy has no receipt and replay can finish without duplicate copies", async () => {
  const { dir, source, options } = await fixture();
  try {
    const missing = path.join(dir, "second.txt");
    const interrupted = { ...options, paths: [source, missing] };
    await expect(storeSentFiles(interrupted)).rejects.toMatchObject({ code: "ENOENT" });
    const callDir = path.join(
      options.rootDir,
      options.workspaceId,
      options.sessionId,
      options.toolCallId,
    );
    expect(await readdir(callDir)).toEqual(["01-artifact.txt"]);
    // A process stop during receipt writing can leave an unpublished temporary file.
    await writeFile(path.join(callDir, "manifest.json.interrupted.tmp"), "{unfinished");
    await writeFile(missing, "second artifact");
    const completed = await storeSentFiles(interrupted);
    await rm(source);
    await rm(missing);
    expect(await storeSentFiles(interrupted)).toEqual(completed);
    expect((await readdir(callDir)).filter((name) => name.endsWith(".txt"))).toEqual([
      "01-artifact.txt",
      "02-second.txt",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("different calls get distinct attachments and a corrupt committed receipt is not overwritten", async () => {
  const { dir, options } = await fixture();
  try {
    const [first] = await storeSentFiles(options);
    const [next] = await storeSentFiles({ ...options, toolCallId: "call-2" });
    expect(next!.id).not.toBe(first!.id);
    expect(next!.storedPath).not.toBe(first!.storedPath);
    const manifest = path.join(path.dirname(first!.storedPath!), "manifest.json");
    await writeFile(manifest, "{corrupt");
    await expect(storeSentFiles(options)).rejects.toThrow(SyntaxError);
    expect(await readFile(manifest, "utf8")).toBe("{corrupt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
