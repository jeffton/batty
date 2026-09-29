import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createTrackedFileTools } from "./agent-file-changes";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("native filesystem mutation artifacts", () => {
  it.each(["write", "edit"])(
    "preserves a completed %s when cancellation follows the filesystem write",
    async (name) => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "batty-native-mutation-"));
      directories.push(cwd);
      const file = path.join(cwd, "input.txt");
      await fs.writeFile(file, "before\n");
      const signal = new AbortController();
      const write = fs.writeFile.bind(fs);
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        await write(...args);
        if (args[0] === file) signal.abort();
      });
      const tool = createTrackedFileTools(cwd).find((candidate) => candidate.name === name)!;
      const args =
        name === "write"
          ? { path: file, content: "after\n" }
          : { path: file, edits: [{ oldText: "before", newText: "after" }] };
      const result = await tool.execute(
        "mutation",
        args,
        signal.signal,
        undefined,
        undefined as never,
      );

      expect(await fs.readFile(file, "utf8")).toBe("after\n");
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Operation aborted" }],
        details: {
          battyFileChanges: [
            {
              path: await fs.realpath(file),
              before: "before\n",
              after: "after\n",
              patch: expect.stringContaining("+after"),
            },
          ],
        },
      });
    },
  );
});
