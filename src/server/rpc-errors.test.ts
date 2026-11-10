import { expect, test } from "vite-plus/test";
import { createNodeRpcHandler } from "./node-rpc";
import { createOwnerRpcHandler, type OwnerRpcServices } from "./owner-rpc";
import type { RemoteConnectionCredentials } from "./remote-access";
import type { RemoteWorkers } from "./remote-workers";
import type { Runtime } from "./runtime";

test.each([
  [Object.assign(new Error("Access denied"), { statusCode: 403 }), "FORBIDDEN"],
  [Object.assign(new Error("Missing file"), { code: "ENOENT" }), "NOT_FOUND"],
  [new RangeError("Invalid cursor"), "BAD_INPUT"],
])("owner and peer operations preserve the same domain failure: %s", async (failure, code) => {
  const fail = async () => {
    throw failure;
  };
  const owner = createOwnerRpcHandler(
    { config: {}, tools: {} } as Runtime,
    {
      remoteOperation: fail,
    } as unknown as OwnerRpcServices,
  );
  const connection = {
    id: "peer",
    instanceId: "instance",
    localGrantId: "grant",
  } as RemoteConnectionCredentials;
  const peer = createNodeRpcHandler(
    {
      access: {
        pairedConnection: () => connection,
        listGrants: () => [{ id: "grant" }],
      },
      runtime: { orchestration: { nodeCommand: fail } },
    } as unknown as RemoteWorkers,
    connection,
  );
  const context = { signal: new AbortController().signal };
  await expect(owner("remotes.get", {}, context)).rejects.toMatchObject({
    code,
    message: failure.message,
  });
  await expect(
    peer("node.command", { requestId: "request", command: { action: "list" } }, context),
  ).rejects.toMatchObject({ code, message: failure.message });
});
