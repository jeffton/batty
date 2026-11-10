import { rpcCall } from "./rpc";
import type { OwnerSessionEvent } from "@/shared/owner-api";

/** A challenge belongs to one live stream; never acknowledge another stream's identity. */
export function createPushForegroundHandler() {
  let clientId: string | undefined;
  let closed = false;
  function onEvent(event: OwnerSessionEvent): void {
    if (closed) return;
    if (event.type === "push-client") {
      clientId = event.clientId;
      return;
    }
    if (
      event.type !== "push-foreground" ||
      event.clientId !== clientId ||
      document.visibilityState !== "visible" ||
      !document.hasFocus()
    )
      return;
    void rpcCall(
      "push.ack",
      { clientId: event.clientId, challengeId: event.challengeId },
      {
        signal: AbortSignal.timeout(1000),
      },
    ).catch((error) => {
      if (!closed && !(error instanceof DOMException && error.name === "TimeoutError"))
        console.error("Acknowledging push foreground", error);
    });
  }
  return {
    onEvent,
    close: () => {
      closed = true;
    },
  };
}
