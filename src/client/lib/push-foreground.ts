import { withBaseUrl } from "./base-url";

/** Acknowledge only a live stream's current challenge while the app is visible. */
export function listenForPushForeground(source: EventSource): () => void {
  let clientId: string | undefined;
  let closed = false;
  const identify = (event: Event) => {
    clientId = (JSON.parse((event as MessageEvent).data) as { clientId: string }).clientId;
  };
  const challenge = (event: Event) => {
    const data = JSON.parse((event as MessageEvent).data) as {
      clientId: string;
      challengeId: string;
    };
    if (closed || data.clientId !== clientId || document.visibilityState !== "visible") return;
    void fetch(withBaseUrl("/api/push/foreground/ack"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(1000),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Push foreground ack: HTTP ${response.status}`);
      })
      .catch((error) => {
        // Suspension and a lost connection let the server send normal push instead.
        if (!closed && !(error instanceof DOMException && error.name === "TimeoutError"))
          console.error("Acknowledging push foreground", error);
      });
  };
  source.addEventListener("push-client", identify);
  source.addEventListener("push-foreground", challenge);
  return () => {
    closed = true;
    source.removeEventListener("push-client", identify);
    source.removeEventListener("push-foreground", challenge);
  };
}
