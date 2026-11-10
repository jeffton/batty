import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime";
import type { RpcHandler } from "../../shared/rpc";
import { registerOwnerSocket } from "../owner-socket";

/** A browser and a paired node share framing, not authorization or operations. */
export async function registerReverseRemoteRoutes(
  app: FastifyInstance,
  runtime: Runtime,
  ownerHandler?: RpcHandler,
) {
  await app.register(websocket, {
    // Event values can include archive pages; only binary chunks have a frame-size bound.
    options: { maxPayload: 0, perMessageDeflate: false },
  });
  const closeOwners = ownerHandler
    ? registerOwnerSocket(app, runtime.config, ownerHandler)
    : undefined;
  app.get(
    "/api/node/socket",
    {
      websocket: true,
      preValidation: async (request) => {
        // Node sockets use bearer credentials only, never ambient browser cookies.
        if (request.headers.origin)
          throw Object.assign(new Error("Browser origins cannot open a node socket"), {
            statusCode: 403,
          });
        const instance = request.headers["x-batty-instance-id"];
        if (!request.nodeGrant || typeof instance !== "string")
          throw Object.assign(new Error("Node identity required"), { statusCode: 403 });
        runtime.remotes.reverse.connectionFor(request.nodeGrant.id, instance);
      },
    },
    (socket, request) => {
      const connection = runtime.remotes.reverse.connectionFor(
        request.nodeGrant!.id,
        request.headers["x-batty-instance-id"] as string,
      );
      runtime.remotes.reverse.accept(connection, socket);
    },
  );
  app.addHook("onListen", async () => {
    runtime.remotes.reverse.start();
  });
  app.addHook("preClose", async () => {
    closeOwners?.();
    await runtime.remotes.reverse.close();
  });
}
