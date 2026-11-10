import { expectTypeOf, test } from "vite-plus/test";
import type { RemoteWorkers } from "../server/remote-workers";
import type { RemoteConnectionCredentials } from "../server/remote-access";
import type { NodeOutputs, NodeWorkerSummary } from "./node-api";
import type { ServerEvent } from "./types";

// Checked by tsc, never sent to a live connection.
async function nodeContract(
  request: RemoteWorkers["requestNode"],
  connection: RemoteConnectionCredentials,
) {
  const identity = await request(connection, "node.identity", {});
  expectTypeOf(identity.value).toEqualTypeOf<NodeOutputs["node.identity"]>();
  expectTypeOf(identity.events).toEqualTypeOf<ReadableStream<never> | undefined>();
  const catalog = await request(connection, "node.catalog.watch", {});
  expectTypeOf(catalog.events).toEqualTypeOf<
    ReadableStream<{ workers: NodeWorkerSummary[] }> | undefined
  >();
  const session = await request(connection, "node.session.watch", { sessionId: "1" });
  expectTypeOf(session.events).toEqualTypeOf<ReadableStream<ServerEvent> | undefined>();
  // @ts-expect-error Peer connections cannot call owner operations.
  await request(connection, "remotes.token.generate", {});
  // @ts-expect-error Session input must contain its session ID.
  await request(connection, "node.session.watch", {});
  // @ts-expect-error Callers cannot invent the response type.
  await request<{ forged: true }>(connection, "node.identity", {});
  await request(connection, "node.command", {
    requestId: "1",
    // @ts-expect-error Commands cannot recursively forward to a different node.
    command: { action: "run", nodeId: "other" },
  });
  // @ts-expect-error Reports are not a remotely callable worker operation.
  await request(connection, "node.command", { requestId: "1", command: { action: "report" } });
}

test("node operations determine input, output and event types", () => {
  expectTypeOf(nodeContract).toBeFunction();
});
