import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveDoc, type RunFailureReason } from "@earendil-works/pi-durable";
import { expect, test, vi } from "vite-plus/test";
import { loadConfig } from "./config";
import { Runtime, context } from "./runtime";

test("session snapshots expose failed runs, suppress intentional stops and clear resolved failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty-run-failure-"));
  vi.stubEnv("PI_OFFLINE", "1");
  await mkdir(join(directory, ".batty"));
  await writeFile(
    join(directory, ".batty", "options.json"),
    JSON.stringify({ workspacesRoots: [directory], webPushSubject: "mailto:test@example.com" }),
  );
  let runtime: Runtime | undefined;
  try {
    runtime = await Runtime.open(await loadConfig(directory), { resume: false });
    const main = runtime.main;
    const failures: [RunFailureReason, string | null][] = [
      ["interrupted", "Run interrupted while answering: request cut off twice"],
      ["restart_limit", "Run stopped after repeated interruptions: request cut off twice"],
      ["model_error", "Model request failed: request cut off twice"],
      ["no_model", "Model unavailable: request cut off twice"],
      ["aborted", null],
      ["reset", null],
    ];
    for (const [reason, expected] of failures) {
      await main.commit(async (tx) => {
        (await tx.doc(LiveDoc, main.id)).runFailure = {
          taskId: 1 as never,
          inputs: [],
          reason,
          detail: "request cut off twice",
        };
      }, context);
      expect((await runtime.state("main", undefined, false)).runFailure).toBe(expected);
      const watch = await main.watch(context);
      expect((await runtime.state("main", watch.value, false)).runFailure).toBe(expected);
      await watch.stop();
    }
    await main.commit(async (tx) => {
      delete (await tx.doc(LiveDoc, main.id)).runFailure;
    }, context);
    // Explicit null survives JSON serialization and clears incremental SSE metadata.
    expect(
      JSON.parse(JSON.stringify(await runtime.state("main", undefined, false))).runFailure,
    ).toBeNull();
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
