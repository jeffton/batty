import type { ServerResponse } from "node:http";

type Response = Pick<
  ServerResponse,
  "write" | "end" | "on" | "removeListener" | "writableNeedDrain" | "destroyed" | "writableEnded"
>;

/** Bounded latest-event slots: a slow viewer must still receive the final state/paint. */
export function createCloudBrowserEventWriter(response: Response) {
  const pending = new Map<string, unknown>();
  let ready = false;
  let closed = false;
  const encode = (event: string, value: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  const flush = () => {
    if (!ready || closed || response.destroyed || response.writableEnded) return;
    for (const event of ["state", "frame", "browser-error"]) {
      if (response.writableNeedDrain || !pending.has(event)) continue;
      const value = pending.get(event);
      pending.delete(event);
      response.write(encode(event, value));
      if (event === "browser-error") response.end();
    }
  };
  response.on("drain", flush);
  return {
    send(event: "state" | "frame" | "browser-error", value: unknown) {
      if (closed || response.destroyed || response.writableEnded) return;
      pending.set(event, value);
      flush();
      // A terminal event must also release slow connections during service stop.
      if (ready && pending.has("browser-error")) {
        response.end(encode("browser-error", pending.get("browser-error")));
        pending.clear();
      }
    },
    start() {
      ready = true;
      flush();
    },
    close() {
      closed = true;
      pending.clear();
      response.removeListener("drain", flush);
    },
  };
}
