import type { ServerResponse } from "node:http";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Runtime } from "./runtime";
import { OrchestrationDoc } from "./orchestration-state";
import type { TranscriptImages } from "./transcript-images";
import type { SessionState } from "../shared/types";

/** A paused socket owns at most one event; do not materialize the next archive page before drain. */
export async function writeStreamEvent(stream: ServerResponse, payload: string): Promise<void> {
  if (stream.destroyed || stream.writableEnded) return;
  if (stream.write(payload)) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      stream.off("drain", done);
      stream.off("close", done);
      resolve();
    };
    stream.once("drain", done);
    stream.once("close", done);
  });
}

/** Live-doc snapshots and coalesced commits never acquire a full ConversationView. */
export function streamSession(
  stream: ServerResponse,
  runtime: Runtime,
  conversationId: ConversationId | string,
  images: TranscriptImages,
  initialAfter: string | undefined,
  onError: (error: unknown) => void,
  projection?: {
    state(includeHistory: boolean, after?: string): Promise<SessionState>;
    subscribe(changed: (history: boolean) => void): () => void;
  },
) {
  let after = initialAfter;
  let closed = false;
  let flushing = false;
  let dirty = true;
  let historyDirty = true;
  const notifyOrchestration = !projection && Number(conversationId) === runtime.main.id;
  let orchestrationDirty = notifyOrchestration;
  let cronDirty = notifyOrchestration;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const write = (event: object) => writeStreamEvent(stream, `data: ${JSON.stringify(event)}\n\n`);
  async function flush() {
    if (flushing || closed) return;
    flushing = true;
    try {
      while (dirty && !closed) {
        const includeHistory = historyDirty;
        dirty = false;
        historyDirty = false;
        if (orchestrationDirty) {
          const cron = cronDirty;
          orchestrationDirty = false;
          cronDirty = false;
          await write({ type: "orchestration-changed", cron });
        }
        let state = await images.state(
          await (projection
            ? projection.state(includeHistory, after)
            : runtime.state(String(conversationId), undefined, includeHistory, after)),
        );
        if (includeHistory) {
          for (;;) {
            after = state.historyCursor ?? after;
            await write({
              type: "reset",
              state,
              streamId: runtime.streamId,
              revision: state.revision,
            });
            if (closed || !state.hasMoreRecentMessages) break;
            state = await images.state(
              await (projection
                ? projection.state(true, after)
                : runtime.state(String(conversationId), undefined, true, after)),
            );
          }
        } else {
          const {
            messages: _messages,
            messagesDetailLevel: _detail,
            hasMoreMessages: _more,
            historyAfter: _after,
            historyCursor: _cursor,
            hasMoreRecentMessages: _recent,
            activeAssistant,
            activeTools,
            ...metadata
          } = state;
          await write({
            type: "state",
            state: metadata,
            streamId: runtime.streamId,
            revision: state.revision,
          });
          await write({
            type: "assistant",
            assistant: activeAssistant,
            streamId: runtime.streamId,
            revision: runtime.nextRevision(),
          });
          await write({
            type: "tools",
            tools: activeTools,
            streamId: runtime.streamId,
            revision: runtime.nextRevision(),
          });
        }
      }
    } catch (error) {
      onError(error);
      await write({ type: "error", message: String(error) });
    } finally {
      flushing = false;
    }
  }
  function schedule(history: boolean) {
    if (closed) return;
    dirty = true;
    historyDirty ||= history;
    if (flushing || scheduled !== undefined) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      void flush();
    }, 0);
  }
  const unsubscribe =
    projection?.subscribe(schedule) ??
    runtime.harness.subscribeCommits((publication) => {
      let changed = false;
      let entries = false;
      for (const change of publication.changes) {
        // Delivery tasks are owned by the parent, and orchestration is session-scoped.
        // Their commits can change worker stop availability without a worker entry.
        if (
          ((change.type === "document" || change.type === "document.copy") &&
            change.record.kind === OrchestrationDoc.definition.kind) ||
          (change.type === "task" &&
            change.value.kind === "batty.delivery" &&
            (change.value.input as { workerId: string }).workerId === String(conversationId))
        )
          changed = true;
        if (
          notifyOrchestration &&
          (change.type === "document" || change.type === "document.copy") &&
          change.record.kind === OrchestrationDoc.definition.kind
        ) {
          orchestrationDirty = true;
          cronDirty = true;
        }
        const owner =
          change.type === "document" || change.type === "document.copy"
            ? change.conversationId
            : change.type === "conversation"
              ? change.value.id
              : change.value.conversationId;
        if (owner !== conversationId) continue;
        changed = true;
        entries ||= change.type === "entry";
      }
      if (changed) schedule(entries);
    });
  let remoteTasks = notifyOrchestration
    ? JSON.stringify(runtime.remotes.tasks(Number(conversationId)))
    : "";
  const remoteChanged = () => {
    const next = JSON.stringify(runtime.remotes.tasks(Number(conversationId)));
    if (next === remoteTasks) return;
    remoteTasks = next;
    orchestrationDirty = true;
    schedule(false);
  };
  if (notifyOrchestration) runtime.remotes.changes.on("change", remoteChanged);
  let memory = projection ? "" : JSON.stringify(runtime.memory.status());
  const memoryTimer = projection
    ? undefined
    : setInterval(() => {
        const next = JSON.stringify(runtime.memory.status());
        if (next === memory) return;
        memory = next;
        schedule(false);
      }, 2000);
  const heartbeat = setInterval(() => {
    if (!closed && !stream.writableNeedDrain) stream.write("event: heartbeat\ndata: {}\n\n");
  }, 5000);
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(scheduled);
    clearInterval(memoryTimer);
    clearInterval(heartbeat);
    unsubscribe();
    if (notifyOrchestration) runtime.remotes.changes.off("change", remoteChanged);
  }
  stream.once("close", close);
  void flush();
  return close;
}
