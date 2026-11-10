import type { ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, ConversationView } from "@earendil-works/pi-durable";
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
  const controller = new AbortController();
  stream.once("close", () => controller.abort());
  const close = observeSession(
    runtime,
    conversationId,
    images,
    initialAfter,
    (event) => writeStreamEvent(stream, `data: ${JSON.stringify(event)}\n\n`),
    controller.signal,
    onError,
    projection,
  );
  const heartbeat = setInterval(() => {
    if (!stream.destroyed && !stream.writableNeedDrain)
      stream.write("event: heartbeat\ndata: {}\n\n");
  }, 5000);
  controller.signal.addEventListener("abort", () => clearInterval(heartbeat), { once: true });
  return () => {
    controller.abort();
    close();
  };
}

/** Transport-neutral session projection. emit resolves when the consumer can accept more. */
export function observeSession(
  runtime: Runtime,
  conversationId: ConversationId | string,
  images: TranscriptImages,
  initialAfter: string | undefined,
  emit: (event: object) => Promise<void>,
  signal: AbortSignal,
  onError: (error: unknown) => void,
  projection?: {
    state(includeHistory: boolean, after?: string): Promise<SessionState>;
    subscribe(changed: (history: boolean) => void): () => void;
  },
) {
  let after = initialAfter;
  let view: ConversationView | undefined;
  let closed = false;
  let flushing = false;
  let dirty = true;
  let historyDirty = true;
  const notifyOrchestration = !projection && Number(conversationId) === runtime.main.id;
  let orchestrationDirty = notifyOrchestration;
  let cronDirty = notifyOrchestration;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const write = emit;
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
            : runtime.state(String(conversationId), view, includeHistory, after)),
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
                : runtime.state(String(conversationId), view, true, after)),
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
      if (closed) return;
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
  let detachConversation = () => {};
  const unsubscribe =
    projection?.subscribe(schedule) ??
    (() => {
      const commits = runtime.harness.observeCommits({
        advance(publication) {
          let changed = false;
          for (const change of publication.changes) {
            // Delivery tasks are owned by the parent, and orchestration is session-scoped.
            // Their commits can change worker stop availability without a worker entry.
            if (
              (change.type === "document" &&
                change.record.kind === OrchestrationDoc.definition.kind) ||
              (change.type === "task" &&
                change.value.kind === "batty.delivery" &&
                (change.value.input as { workerId: string }).workerId === String(conversationId))
            )
              changed = true;
            if (
              notifyOrchestration &&
              change.type === "document" &&
              change.record.kind === OrchestrationDoc.definition.kind
            ) {
              orchestrationDirty = true;
              cronDirty = true;
            }
          }
          if (changed) schedule(false);
        },
        end(end) {
          if (!closed && (end.kind === "failed" || end.kind === "listener_error"))
            onError(end.error);
        },
      });
      return () => commits.detach();
    })();
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
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(scheduled);
    clearInterval(memoryTimer);
    signal.removeEventListener("abort", close);
    unsubscribe();
    detachConversation();
    if (notifyOrchestration) runtime.remotes.changes.off("change", remoteChanged);
  }
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) {
    close();
    return close;
  }
  if (projection) {
    void flush();
  } else {
    // Observe memory, not just stored commits: deferred generation/tool progress must
    // reach the socket immediately. Entries remain loaded through runtime's paginated
    // history index, never from this observer's bounded transcript window.
    void runtime.harness
      .observeConversation(
        Number(conversationId) as ConversationId,
        {
          advance(call) {
            if (call.kind !== "value") return;
            const previousLast = view?.entries.at(-1)?.id;
            view = call.value;
            schedule(previousLast !== view.entries.at(-1)?.id);
          },
          end(end) {
            if (!closed && (end.kind === "failed" || end.kind === "listener_error"))
              onError(end.error);
          },
        },
        BACKGROUND_CONTEXT,
      )
      .then((observation) => {
        detachConversation = () => observation.detach();
        if (closed) {
          detachConversation();
          return;
        }
        view ??= observation.value;
        void flush();
      })
      .catch((error) => {
        if (!closed) onError(error);
      });
  }
  return close;
}
