import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Harness, type TaskId } from "@earendil-works/pi-durable";
import { OrchestrationDoc } from "./orchestration";
import { ArchivedWorker, DeliveryRecord } from "./orchestration-history";

/** Test-only archive projection; production status polling uses the hot register. */
export async function orchestrationHistory(harness: Harness) {
  const state = { ...structuredClone((await harness.snapshot(OrchestrationDoc, context))!) };
  const { conversations, tasks } = await harness.commit(async (tx) => {
    const conversations = [];
    const tasks = [];
    let cursor;
    do {
      const page = await tx.scanConversations({}, 200, cursor);
      conversations.push(...page.items);
      cursor = page.next;
    } while (cursor);
    do {
      const page = await tx.scanTasks({}, 200, cursor);
      tasks.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return { conversations, tasks };
  }, context);
  for (const conversation of conversations) {
    const worker = await harness.snapshot(ArchivedWorker, String(conversation.id), context);
    if (worker && !state.workers[String(conversation.id)])
      state.workers[String(conversation.id)] = { ...worker };
  }
  for (const task of tasks) {
    const record = await harness.snapshot(DeliveryRecord, String(task.id as TaskId), context);
    if (record?.call) state.calls[String(task.id)] = record.call;
    if (record?.join) (state.joins ??= {})[String(task.id)] = record.join;
  }
  return state;
}
