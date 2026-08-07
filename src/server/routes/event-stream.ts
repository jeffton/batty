import type { ServerResponse } from "node:http";

export function startEventStream(
  response: Pick<ServerResponse, "writeHead" | "flushHeaders">,
): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  response.flushHeaders();
}
