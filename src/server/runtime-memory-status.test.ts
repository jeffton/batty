import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { loadConfig } from "./config";
import { Runtime, context } from "./runtime";

test("session snapshots separate declined main tasks, OptChat preparation/errors and worker compaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty-memory-status-"));
  vi.stubEnv("PI_OFFLINE", "1");
  await mkdir(join(directory, ".batty"));
  await writeFile(
    join(directory, ".batty", "options.json"),
    JSON.stringify({ workspacesRoots: [directory], webPushSubject: "mailto:test@example.com" }),
  );
  let runtime: Runtime | undefined;
  try {
    runtime = await Runtime.open(await loadConfig(directory), { resume: false });
    const originalView = (await runtime.main.watch(context)).value;
    // Threshold checks briefly publish a native task before main's decline hook runs.
    const mainView = {
      ...originalView,
      docs: { ...originalView.docs, "pi.live": { compactions: [{ id: 1 }] } },
    };
    const status = vi.spyOn(runtime.memory, "status");
    status.mockReturnValue({
      settled: 0,
      cacheBytes: 0,
      cacheEntries: 0,
      pending: 8,
      totalLeaves: 10,
      builtLeaves: 2,
      error: undefined,
    });
    expect(await runtime.state("main", mainView, false)).toMatchObject({
      isCompacting: false,
      memoryPreparation: { pending: 8 },
    });
    status.mockReturnValue({
      settled: 0,
      cacheBytes: 0,
      cacheEntries: 0,
      pending: 0,
      totalLeaves: 10,
      builtLeaves: 10,
      error: "Summary failed",
    });
    expect(await runtime.state("main", mainView, false)).toMatchObject({
      isCompacting: false,
      memoryPreparation: { pending: 0, error: "Summary failed" },
    });
    const worker = await runtime.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    );
    const originalWorkerView = (await worker.watch(context)).value;
    const workerView = {
      ...originalWorkerView,
      docs: { ...originalWorkerView.docs, "pi.live": mainView.docs["pi.live"] },
    };
    const workerState = await runtime.state(String(worker.id), workerView, false);
    expect(workerState.isCompacting).toBe(true);
    expect(workerState.memoryPreparation).toBeUndefined();
    status.mockReturnValue({
      settled: 0,
      cacheBytes: 0,
      cacheEntries: 0,
      pending: 0,
      totalLeaves: 10,
      builtLeaves: 10,
      error: undefined,
    });
    expect((await runtime.state("main", mainView, false)).memoryPreparation?.error).toBeUndefined();
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
