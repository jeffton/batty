import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  Harness,
  type Conversation,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, test, vi } from "vite-plus/test";
import { createDeliveryTask } from "./orchestration-delivery.js";
import { ArchivedWorker } from "./orchestration-history.js";
import { OrchestrationDoc, WorkerDoc, type OrchestrationServices } from "./orchestration-state.js";

// A retry checkpoint can be persisted after an assignment was already admitted.
// Reopening must retain that admission and the original deadline, rather than
// starting the assignment (or its preparation) again.
test("batty.delivery retry sleeps across reopen and completes its existing assignment once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty-delivery-sleep-"));
  const path = join(directory, "session.sqlite");
  let harness: Harness | undefined;
  let main!: Conversation;
  let now = 1000;
  const faux = fauxProvider({ tokensPerSecond: 10000, models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const prepareAgent = vi.fn(async () => ({}));
  const services: OrchestrationServices = {
    get harness() {
      return harness!;
    },
    get main() {
      return main;
    },
    prepareAgent,
    workspace: async () => ({ id: "test", path: directory }),
    assistantWorkspaceId: async () => "test",
  };
  const Delivery = createDeliveryTask(services);
  const open = async () => {
    harness = await Harness.open(
      await openNodeSqliteStorage(path),
      {
        models,
        registry,
        now: () => now,
        // Model a host-provided alarm: advance time only by closing/reopening.
        onWake: () => {},
      },
      context,
    );
    main = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "test" }, cwd: directory },
    });
    return harness;
  };
  try {
    await open();
    const child = await harness!.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "faux", modelId: "test" }, cwd: directory },
      },
      context,
    );
    const workerId = String(child.id);
    // Seed only the persisted checkpoint. The registry runs the actual
    // createDeliveryTask definition; no phase or runtime API is mocked.
    const retryCheckpoint = {
      ...Delivery,
      definition: {
        ...Delivery.definition,
        initial: () => ({ phase: "deliver" as const, retryAt: 2000 }),
      },
    };
    const deliveryId = await main.commit(async (tx) => {
      const id = await tx.createTask(
        retryCheckpoint,
        {
          workerId,
          childId: child.id,
          mainId: main.id,
          prompt: "existing assignment",
          report: false,
          change: { cwd: "/must-not-reapply-after-admission" },
          remoteAssignment: { grantId: "test-grant", requestId: "original-request" },
        },
        { ownership: { kind: "conversation" }, background: true },
      );
      (await tx.doc(OrchestrationDoc)).workers[workerId] = {
        id: child.id,
        parentId: main.id,
        workspaceId: "test",
        prompt: "existing assignment",
        active: id,
        reported: [],
      };
      return id;
    }, context);
    // The delivery definition is not installed yet, so admitting this original
    // input cannot run the delivery before its existing receipt is committed.
    const answer = vi.fn(() => fauxAssistantMessage([fauxText("assignment completed")]));
    faux.setResponses([answer]);
    const original = await child.submit(
      {
        type: "input",
        content: "existing assignment",
        requestId: `batty-deliver:${deliveryId}`,
      },
      context,
    );
    expect((await original.wait(context)).status).toBe("done");
    await main.commit(async (tx) => {
      (await tx.doc(WorkerDoc, child.id)).completion = {
        owner: deliveryId,
        inputs: [original.id],
        waits: {},
      };
    }, context);
    registry.install(defineExtension({ name: "delivery-sleep-test", tasks: [Delivery] }));
    await expect
      .poll(async () => (await harness!.getTask(deliveryId, context))?.state.status)
      .toBe("sleeping");
    expect((await harness!.getTask(deliveryId, context))?.state).toEqual({
      status: "sleeping",
      until: 2000,
      checkpoint: { phase: "deliver", retryAt: 2000 },
    });
    expect(harness!.wake()).toEqual({ active: false, at: 2000 });
    expect(prepareAgent).not.toHaveBeenCalled();
    await harness!.close(context);

    now = 1999;
    await open();
    harness!.resume();
    expect(
      (await harness!.inspect(context)).tasks.find((task) => task.record.id === deliveryId)?.state,
    ).toEqual({
      kind: "sleeping",
      until: 2000,
    });
    expect(
      (await harness!.snapshot(WorkerDoc, child.id, context))?.latestResultAssignment,
    ).toBeUndefined();
    expect(answer).toHaveBeenCalledTimes(1);
    await harness!.close(context);

    now = 2000;
    await open();
    expect((await harness!.waitForTask(deliveryId, context)).state).toEqual({
      status: "terminal",
      outcome: { status: "completed", result: "assignment completed" },
    });
    expect((await harness!.snapshot(WorkerDoc, child.id, context))?.latestResultAssignment).toBe(
      deliveryId,
    );
    expect((await harness!.snapshot(WorkerDoc, child.id, context))?.completion).toBeUndefined();
    expect((await harness!.snapshot(OrchestrationDoc, context))?.workers[workerId]).toBeUndefined();
    expect(await harness!.snapshot(ArchivedWorker, workerId, context)).toMatchObject({
      active: deliveryId,
    });
    await harness!.close(context);

    await open();
    await harness!.waitForTask(deliveryId, context);
    const resumedChild = (await harness!.conversation(child.id, context))!;
    const entries = (await resumedChild.entries({}, 100, undefined, context)).items;
    expect(entries.filter((entry) => entry.kind === "batty.remote-result")).toHaveLength(1);
    expect(entries.find((entry) => entry.kind === "batty.remote-result")?.data).toMatchObject({
      assignmentId: String(deliveryId),
      text: "assignment completed",
      failed: false,
    });
    expect(
      await harness!.commit(
        (tx) => tx.submissionByRequest(child.id, `batty-deliver:${deliveryId}`),
        context,
      ),
    ).toMatchObject({ id: original.id });
    expect((await resumedChild.agent(context)).cwd).toBe(directory);
    expect(prepareAgent).not.toHaveBeenCalled();
    expect(answer).toHaveBeenCalledTimes(1);
  } finally {
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
