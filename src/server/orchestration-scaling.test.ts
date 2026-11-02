import { expect, test, vi } from "vite-plus/test";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  type TaskId,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createOrchestration, OrchestrationDoc } from "./orchestration";
import { ArchivedWorker } from "./orchestration-history";

test("5,000 completed deliveries leave zero hot workers/tasks and bounded run-history reads", async () => {
  const storage = new MemoryStorage();
  const registry = createRegistry();
  const orchestration = createOrchestration();
  registry.install(orchestration.extension);
  const harness = await Harness.open(storage, { models: createModels(), registry }, context);
  try {
    const main = await harness.root(context);
    const writes: StorageWrite[] = [];
    const ids: TaskId<string>[] = [];
    for (let i = 0; i < 5000; i++) {
      const id = await storage.mintId<TaskId<string>>();
      ids.push(id);
      writes.push({
        type: "task",
        value: {
          id,
          conversationId: main.id,
          kind: "batty.delivery",
          version: 1,
          input: {},
          background: true,
          abortRequested: false,
          state: {
            status: "terminal",
            outcome: { status: "completed", result: "archived answer" },
          },
        },
      });
    }
    await commitWrites(storage, writes, context);
    let lastWorker = "";
    await main.commit(async (tx) => {
      const doc = await tx.doc(OrchestrationDoc);
      for (let i = 0; i < ids.length; i++) {
        const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
        lastWorker = String(child.id);
        doc.workers[lastWorker] = {
          id: child.id,
          parentId: main.id,
          workspaceId: "roy",
          prompt: "original task",
          active: ids[i]!,
          reported: [],
        };
        doc.calls[String(ids[i])] = { workerId: lastWorker, taskId: ids[i]! };
        doc.runs[`job:${i}`] = {
          id: `job:${i}`,
          jobId: "job",
          workspaceId: "roy",
          scheduledAt: i,
          startedAt: i,
          taskId: ids[i]!,
          sessionId: lastWorker,
          status: "completed",
          output: `answer ${i}`,
        };
      }
    }, context);
    const started = performance.now();
    await orchestration.bind(harness, main);
    const migratedMs = performance.now() - started;
    const taskReads = vi.spyOn(harness, "getTask");
    const docReads = vi.spyOn(harness, "snapshot");
    const pollStarted = performance.now();
    for (let i = 0; i < 20; i++) expect(await orchestration.listRunning()).toEqual([]);
    expect(taskReads).not.toHaveBeenCalled();
    docReads.mockClear();
    const runs = await orchestration.listRunLogs("job", 10, "roy");
    expect(runs.map((run) => run.output)).toEqual(
      Array.from({ length: 10 }, (_, i) => `answer ${4999 - i}`),
    );
    expect(docReads).toHaveBeenCalledTimes(12); // head, one 100-ID page, ten exact run records
    expect((await harness.snapshot(ArchivedWorker, lastWorker, context))?.prompt).toBe(
      "original task",
    );
    const hot = (await harness.snapshot(OrchestrationDoc, context))!;
    expect(Object.keys(hot.workers)).toHaveLength(0);
    expect(Object.keys(hot.runs)).toHaveLength(0);
    expect(Object.keys(hot.calls)).toHaveLength(0);
    console.log(
      `orchestration: 5,000-record migration ${migratedMs.toFixed(0)}ms; 20 idle polls + ten-run archive read ${(performance.now() - pollStarted).toFixed(1)}ms; zero old-task lookups`,
    );
  } finally {
    orchestration.close();
    await harness.close(context);
  }
}, 30000);
