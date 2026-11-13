import type { Models } from "@earendil-works/pi-ai/models";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

export const MODEL_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** Provider timeouts may cover only response headers. Bound silence through completion,
 * not total reasoning time, tool execution, or durable/offline waits. */
export function withModelStreamTimeout(
  streamSimple: Models["streamSimple"],
  prepareRequest?: (request: Context) => Promise<Context>,
): Models["streamSimple"] {
  return (model, context, options) => {
    const timeoutMs = options?.timeoutMs ?? MODEL_STREAM_IDLE_TIMEOUT_MS;
    const controller = new AbortController();
    const output = new AssistantMessageEventStream();
    let partial: AssistantMessage | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown, aborted = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Copy before aborting: providers mutate their partial when cancellation arrives.
      const message: AssistantMessage = {
        ...(partial
          ? structuredClone(partial)
          : {
              role: "assistant" as const,
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              timestamp: Date.now(),
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            }),
        stopReason: aborted ? "aborted" : "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      output.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
      output.end();
      controller.abort(error);
    };
    const onAbort = () => fail(options!.signal!.reason, true);
    const progress = () => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const error = new Error(
          `Model stream stalled: no provider progress for ${timeoutMs} ms (${model.provider}/${model.id})`,
        );
        console.warn(error.message);
        fail(error);
      }, timeoutMs);
      timer.unref();
    };

    if (options?.signal?.aborted) {
      onAbort();
      return output;
    }
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    progress();
    void (async () => {
      const prepared = prepareRequest ? await prepareRequest(context) : context;
      if (settled) return;
      const source = streamSimple(model, prepared, {
        ...options,
        signal: controller.signal,
        onProviderStreamEvent: (event, eventModel) => {
          // Parsed model events include reasoning/tool progress absent from normalized
          // deltas. Transport pings are not progress toward completing a response.
          const type = (event as { type?: string } | null)?.type;
          if (type !== "ping" && type !== "heartbeat") progress();
          return options?.onProviderStreamEvent?.(event, eventModel);
        },
      });
      for await (const event of source) {
        if (settled) return;
        if (event.type === "done" || event.type === "error") {
          settled = true;
          cleanup();
          output.push(event);
          output.end();
          return;
        }
        partial = event.partial;
        progress();
        output.push(event);
      }
      const result = await source.result();
      if (settled) return;
      settled = true;
      cleanup();
      output.end(result);
    })().catch((error: unknown) => fail(error));
    return output;
  };
}
