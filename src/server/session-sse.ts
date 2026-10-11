import type { ServerResponse } from "node:http";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Runtime } from "./runtime";
import type { TranscriptImages } from "./transcript-images";

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
  conversationId: ConversationId,
  images: TranscriptImages,
  initialAfter: string | undefined,
  onError: (error: unknown) => void,
) {
  let after = initialAfter;
  let closed = false;
  let flushing = false;
  let dirty = true;
  let historyDirty = true;
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
        let state = await images.state(
          await runtime.state(String(conversationId), undefined, includeHistory, after),
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
              await runtime.state(String(conversationId), undefined, true, after),
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
  const unsubscribe = runtime.harness.subscribeCommits((publication) => {
    let changed = false;
    let entries = false;
    for (const change of publication.changes) {
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
  let memory = JSON.stringify(runtime.memory.status());
  const memoryTimer = setInterval(() => {
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
  }
  stream.once("close", close);
  void flush();
  return close;
}
