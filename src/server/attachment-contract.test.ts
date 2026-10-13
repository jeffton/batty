import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { storeSentFiles } from "./send-files";

test("stored attachment paths survive removal of the source and can be explicitly reattached", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "batty-attachment-contract-"));
  try {
    const source = path.join(dir, "original.txt");
    await writeFile(source, "child artifact");
    const options = {
      rootDir: path.join(dir, "sent"),
      cwd: dir,
      workspaceId: "project",
      sessionId: "child",
      toolCallId: "first",
      paths: [source],
    };
    const [child] = await storeSentFiles(options);
    await rm(source);
    expect(path.isAbsolute(child!.storedPath!)).toBe(true);
    expect(await readFile(child!.storedPath!, "utf8")).toBe("child artifact");
    const [parent] = await storeSentFiles({
      ...options,
      sessionId: "parent",
      toolCallId: "forward",
      paths: [child!.storedPath!],
    });
    expect(parent!.id).not.toBe(child!.id);
    expect(parent!.storedPath).not.toBe(child!.storedPath);
    expect(await readFile(parent!.storedPath!, "utf8")).toBe("child artifact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
