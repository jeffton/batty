import { defineTask, type ConversationId } from "@earendil-works/pi-durable";
import type { OrchestrationServices } from "./orchestration-state";
import { WorkerDoc } from "./orchestration-state";

/** A durable wait/continuation, not a worker runtime. Execution remains on the remote installation. */
export function createRemoteJoin(services: OrchestrationServices) {
  return defineTask<
    { node: string; session: string; assignmentId: string; parentId: ConversationId },
    { phase: "wait" },
    null
  >({
    name: "batty.remote-join",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, runtime, ctx) => {
        await services.remoteWorkers!.join(task.input, runtime.signal);
        await runtime.commit(async (tx) => {
          // The continuation was submitted durably by join(); retain its submission in the parent's assignment.
          const submission = await tx.submissionByRequest(
            task.input.parentId,
            `remote-result:${task.input.node}:${task.input.assignmentId}:${task.input.parentId}`,
          );
          const completion = (await tx.doc(WorkerDoc, task.input.parentId)).completion;
          if (submission && completion && !completion.inputs.includes(submission.id))
            completion.inputs.push(submission.id);
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, ctx);
      },
    },
    abort: async (_, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
}
