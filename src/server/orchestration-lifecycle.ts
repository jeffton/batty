import {
  AgentDoc,
  configure,
  type ConversationId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { ArchivedWorker } from "./orchestration-history.js";
import {
  OrchestrationDoc,
  type CronJob,
  type CronRun,
  type InlineContext,
} from "./orchestration-state.js";

export async function restoreInlineAgent(tx: Tx, id: ConversationId, saved: InlineContext) {
  await configure(tx, id, {
    cwd: saved.cwd,
    model: saved.model,
    thinkingLevel: saved.thinkingLevel,
  });
  if (saved.selection) {
    const state = await tx.doc(AgentDoc, id);
    if (saved.selection.extensions === null) delete state.extensions;
    else state.extensions = saved.selection.extensions;
    if (saved.selection.tools === null) delete state.tools;
    else state.tools = saved.selection.tools;
  }
}
export function removeCompletedOneShot(jobs: Record<string, CronJob>, run: CronRun) {
  const job = jobs[run.jobId];
  if (
    job?.schedule.kind === "at" &&
    !job.enabled &&
    job.nextAt === undefined &&
    job.updatedAt <= run.startedAt &&
    run.status === "completed" &&
    run.finishedAt !== undefined
  ) {
    run.job ??= JSON.parse(JSON.stringify(job)) as CronJob;
    delete jobs[job.id];
  }
}
export async function archiveWorker(tx: Tx, workerId: string, taskId: TaskId<string>) {
  const doc = await tx.doc(OrchestrationDoc);
  const worker = doc.workers[workerId];
  for (const [id, call] of Object.entries(doc.calls)) {
    if (call.taskId === taskId) delete doc.calls[id];
  }
  if (worker?.active === taskId) {
    for (const call of Object.values(doc.calls)) {
      if (call.workerId === workerId && (await tx.task(call.taskId))?.state.status !== "terminal")
        return;
    }
    Object.assign(await tx.doc(ArchivedWorker, workerId, worker), worker);
    delete doc.workers[workerId];
  }
}
