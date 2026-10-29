import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { Models } from "@earendil-works/pi-ai/models";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

export const NETWORK_RETRY_MS = 30_000;
const PROBE_TIMEOUT_MS = 4_000;
const transportCodes = new Set([
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function transportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && transportCodes.has(code)) return true;
  if (error.name === "TimeoutError") return true;
  if (error instanceof AggregateError && error.errors.length > 0)
    return error.errors.every(transportFailure);
  return transportFailure(error.cause);
}

/** HTTP errors prove connectivity too. TLS/configuration errors are not an offline signal. */
export async function networkAvailable(signal?: AbortSignal): Promise<boolean> {
  const probeSignal = AbortSignal.any([
    AbortSignal.timeout(PROBE_TIMEOUT_MS),
    ...(signal ? [signal] : []),
  ]);
  const http = async (url: string) => {
    try {
      const response = await fetch(url, { method: "HEAD", signal: probeSignal });
      await response.body?.cancel();
      return true;
    } catch (error) {
      return !transportFailure(error);
    }
  };
  // An IP-level check distinguishes a broken DNS configuration from no network.
  const tcp = new Promise<boolean>((resolve) => {
    const socket = connect({ host: "1.1.1.1", port: 443, signal: probeSignal });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
  const results = await Promise.all([
    http("https://www.google.com/generate_204"),
    http("https://www.cloudflare.com/cdn-cgi/trace"),
    tcp,
  ]);
  signal?.throwIfAborted();
  return results.some(Boolean);
}

/** Pi providers flatten transport errors; deliberately exclude HTTP/auth/TLS/configuration errors. */
export function isTransportMessage(message: AssistantMessage): boolean {
  const text = (message.errorMessage?.trim() ?? "").replace(
    /^OAuth refresh failed for [^:\s]+:\s*/i,
    "",
  );
  return (
    message.stopReason === "error" &&
    /^(?:fetch failed|terminated|connection error\.?|network error\.?|network request failed|request timed out\.?|socket hang up|WebSocket error|WebSocket closed(?: 1006(?: .*)?)?|WebSocket stream closed before response\.completed|connect (?:ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT)\b.*|getaddrinfo (?:EAI_AGAIN|ENOTFOUND)\b.*)$/i.test(
      text,
    )
  );
}

type StreamSimple = Models["streamSimple"];
type RecoveryOptions = {
  online?: (signal?: AbortSignal) => Promise<boolean>;
  wait?: (signal?: AbortSignal) => Promise<void>;
  report?: (message: string) => void;
};

/** Keep the durable request pending, rather than committing an assistant error while offline. */
export function recoverNetwork(
  streamSimple: StreamSimple,
  {
    online = networkAvailable,
    wait = async (signal) => {
      await delay(NETWORK_RETRY_MS, undefined, { signal });
    },
    report = console.warn,
  }: RecoveryOptions = {},
): StreamSimple {
  return (model, context, options) => {
    let source = streamSimple(model, context, options);
    const output = new AssistantMessageEventStream();
    let last: AssistantMessage | undefined;
    void (async () => {
      let waiting = false;
      for (;;) {
        let terminal: AssistantMessageEvent | undefined;
        for await (const event of source) {
          if (event.type === "done" || event.type === "error") terminal = event;
          // Providers mutate the partial into the terminal error object. Snapshot its
          // metadata so durable cannot persist that error through an earlier delta.
          else {
            const partial = { ...event.partial, stopReason: "pending" as const };
            delete partial.errorMessage;
            output.push({ ...event, partial });
          }
        }
        last = await source.result();
        if (!isTransportMessage(last) || (await online(options?.signal))) {
          if (waiting) report("Network available; resuming model request.");
          if (terminal) output.push(terminal);
          else output.end(last);
          return;
        }
        if (!waiting)
          report("Network unavailable; model request remains pending until connectivity returns.");
        waiting = true;
        do {
          await wait(options?.signal);
        } while (!(await online(options?.signal)));
        options?.signal?.throwIfAborted();
        source = streamSimple(model, context, options);
      }
    })().catch((error: unknown) => {
      // Abort is handled by durable's task signal, never as a persisted model error.
      const message: AssistantMessage = {
        ...(last ?? {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: Date.now(),
        }),
        stopReason: options?.signal?.aborted ? "aborted" : "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      output.push({
        type: "error",
        reason: message.stopReason as "error" | "aborted",
        error: message,
      });
    });
    return output;
  };
}
