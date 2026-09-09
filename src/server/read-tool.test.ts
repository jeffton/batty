import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BACKGROUND_CONTEXT, createReadTool } from "@earendil-works/pi-agent-core";
import { TrackedExecutionEnv } from "./harness-file-changes";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function read(text: string, args: { offset?: number; limit?: number } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "batty-read-test-"));
  dirs.push(cwd);
  await fs.writeFile(path.join(cwd, "input.txt"), text);
  return createReadTool().execute(
    "read-test",
    { path: "input.txt", ...args },
    () => {},
    { env: new TrackedExecutionEnv({ cwd }) },
    undefined as never,
    BACKGROUND_CONTEXT,
  );
}

describe("read tool explicit ranges", () => {
  it("retains the byte cap for path-only reads", async () => {
    const result = await read("x".repeat(60_000));
    expect(result.details?.truncation?.firstLineExceedsLimit).toBe(true);
  });

  it.each([{ limit: 1 }, { offset: 1, limit: 1 }])(
    "returns a complete oversized line with %j",
    async (args) => {
      const text = "😀".repeat(20_000);
      const result = await read(text, args);
      expect(result.content).toEqual([{ type: "text", text }]);
      expect(result.details).toBeUndefined();
    },
  );

  it("honors an explicit range beyond both default caps", async () => {
    const lines = Array.from({ length: 3_002 }, (_, i) => `${i}:${"x".repeat(30)}`);
    const result = await read(lines.join("\n"), { offset: 2, limit: 3_000 });
    expect(result.content).toEqual([
      {
        type: "text",
        text: `${lines.slice(1, 3_001).join("\n")}\n\n[1 more lines in file. Use offset=3002 to continue.]`,
      },
    ]);
    expect(result.details).toBeUndefined();
  });

  it("keeps the byte cap for offset-only reads", async () => {
    const result = await read(`skip\n${"x".repeat(60_000)}`, { offset: 2 });
    expect(result.details?.truncation?.firstLineExceedsLimit).toBe(true);
  });

  it("keeps the byte cap and continuation for offset-only multiline reads", async () => {
    const result = await read(Array(2_500).fill("x".repeat(30)).join("\n"), { offset: 2 });
    expect(result.details?.truncation).toMatchObject({ truncatedBy: "bytes" });
    expect(result.details?.truncation?.outputBytes).toBeLessThanOrEqual(50 * 1024);
  });

  it("keeps the default line cap for offset-only reads", async () => {
    const result = await read(Array(2_500).fill("x").join("\n"), { offset: 1 });
    expect(result.details?.truncation).toMatchObject({ truncatedBy: "lines", outputLines: 2_000 });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("Use offset=2001 to continue."),
    });
  });

  it("reports out-of-range offsets", async () => {
    await expect(read("one\ntwo", { offset: 3 })).rejects.toThrow("beyond end of file");
  });
});
