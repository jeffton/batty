import type { ServerEvent } from "@/shared/types";
import type { Runtime } from "./runtime";

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
