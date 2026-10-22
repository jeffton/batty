import {
  defineDocFamily,
  type ConversationId,
  type TaskId,
  type EntryId,
  type Tx,
  type DocumentReader,
} from "@earendil-works/pi-durable";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { CronRun } from "./orchestration";
import type { AgentTurnArtifacts } from "./agent-turn-file-changes";

export type WorkerRecord = {
  id: ConversationId;
  parentId: ConversationId;
  workspaceId: string;
  prompt: string;
  active?: TaskId<string>;
  startedAtMs?: number;
  reported: EntryId[];
};
export const ArchivedWorker = defineDocFamily<WorkerRecord, WorkerRecord>({
  kind: "batty.worker-record",
  checkpointWhen: () => false,
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
});
export const ArchivedRun = defineDocFamily<CronRun, CronRun>({
  kind: "batty.cron-run",
  checkpointWhen: () => false,
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
});
export const DeliveryRecord = defineDocFamily<
  {
    call?: { workerId: string; taskId: TaskId<string> };
    join?: TaskId;
    artifacts?: AgentTurnArtifacts & Record<string, JsonValue>;
    directDelivered?: boolean;
  },
  Record<string, never>
>({
  kind: "batty.delivery-record",
  checkpointWhen: () => false,
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({}),
});

const PAGE_SIZE = 100;
const RunHead = defineDocFamily<{ page: number }, { page: number }>({
  kind: "batty.run-head",
  checkpointWhen: () => false,
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
});
const RunPage = defineDocFamily<{ ids: string[] }, { ids: string[] }>({
  kind: "batty.run-page",
  checkpointWhen: () => false,
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
});
function bucket(jobId?: string, workspaceId?: string): string {
  return JSON.stringify([jobId ?? null, workspaceId ?? null]);
}

/** Admission-order indexes avoid reading/sorting the complete run archive on each poll. */
export async function indexRun(tx: Tx, run: CronRun): Promise<void> {
  await tx.doc(ArchivedRun, run.id, run);
  for (const key of [
    bucket(),
    bucket(run.jobId),
    bucket(undefined, run.workspaceId),
    bucket(run.jobId, run.workspaceId),
  ]) {
    const head = await tx.doc(RunHead, key, { page: 0 });
    let page = await tx.doc(RunPage, `${key}:${head.page}`, { ids: [] });
    if (page.ids.length === PAGE_SIZE) {
      head.page += 1;
      page = await tx.doc(RunPage, `${key}:${head.page}`, { ids: [] });
    }
    page.ids.push(run.id);
  }
}

export async function readRuns(
  reader: DocumentReader,
  context: Context,
  jobId?: string,
  limit = 100,
  workspaceId?: string,
): Promise<CronRun[]> {
  const key = bucket(jobId, workspaceId);
  const head = await reader.snapshot(RunHead, key, context);
  const runs: CronRun[] = [];
  for (let number = head?.page ?? -1; number >= 0 && runs.length < limit; number--) {
    const page = (await reader.snapshot(RunPage, `${key}:${number}`, context))!;
    for (const id of [...page.ids].reverse().slice(0, limit - runs.length)) {
      runs.push({ ...(await reader.snapshot(ArchivedRun, id, context))! });
    }
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt);
}
