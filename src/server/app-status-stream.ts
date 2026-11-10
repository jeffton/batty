import type { ServerResponse } from "node:http";
import type { ServerEvent } from "@/shared/types";
import type { Runtime } from "./runtime";
import { writeStreamEvent } from "./session-sse";

/** Installation status shares the authenticated main stream, independently of transcript revisions. */
export function streamAppStatus(
  stream: ServerResponse,
  runtime: Pick<Runtime, "providerAuth" | "providerUsage" | "tools">,
  buildId: string,
  onError: (error: unknown) => void,
): () => void {
  const controller = new AbortController();
  stream.once("close", () => controller.abort());
  const close = observeAppStatus(
    runtime,
    buildId,
    (event) => writeStreamEvent(stream, `data: ${JSON.stringify(event)}\n\n`),
    controller.signal,
    onError,
  );
  return () => {
    controller.abort();
    close();
  };
}

export function observeAppStatus(
  runtime: Pick<Runtime, "providerAuth" | "providerUsage" | "tools">,
  buildId: string,
  emit: (event: ServerEvent) => Promise<void>,
  signal: AbortSignal,
  onError: (error: unknown) => void,
): () => void {
  let closed = false;
  let pending = Promise.resolve();
  const send = (event: ServerEvent) => {
    pending = pending
      .then(async () => {
        if (!closed) await emit(event);
      })
      .catch(onError);
  };
  send({ type: "build", buildId });
  const unsubscribeProvider = runtime.providerAuth.subscribeAttempts((attempt) =>
    send({ type: "provider-auth-attempt", attempt }),
  );
  const unsubscribeMcp = runtime.tools.mcp.subscribeAttempts((attempt) =>
    send({ type: "mcp-auth-attempt", attempt }),
  );
  send({
    type: "auth-attempts",
    provider: runtime.providerAuth.listAuthAttempts(),
    mcp: runtime.tools.mcp.listAuthAttempts(),
  });
  const unsubscribeUsage = runtime.providerUsage.subscribe((update) =>
    send({ type: "provider-usage", update }),
  );
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribeProvider();
    unsubscribeMcp();
    unsubscribeUsage();
    signal.removeEventListener("abort", close);
  };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  return close;
}
