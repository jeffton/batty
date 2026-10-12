import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { createAttachFilesTool } from "./custom-tools";
import { storeSentFiles } from "./send-files";

test("attach_files describes execution ownership and explicit child forwarding", () => {
  const tool = createAttachFilesTool({} as never);
  expect(tool.description).toContain("current agent");
  expect(tool.description).toContain("call attach_artifacts with the listed file refs");
  expect(tool.description).toContain("Use attach_files to import local files by path");
  expect(tool.description).toContain("Copying attachment:// links does not deliver attachments");
  expect(tool.promptGuidelines).toContainEqual(
    expect.stringContaining("do not automatically forward every draft"),
  );
});

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
