import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime";
import { SOCKET_MAX_FRAME_BYTES } from "../../shared/socket-channel";
import { registerOwnerSocket } from "../socket-dispatch";

/** A browser and a paired node share framing, not authorization. */
export async function registerReverseRemoteRoutes(app: FastifyInstance, runtime: Runtime) {
  await app.register(websocket, {
    options: { maxPayload: SOCKET_MAX_FRAME_BYTES, perMessageDeflate: false },
  });
  let localUrl: string;
  const closeOwners = registerOwnerSocket(app, () => localUrl);
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
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("Socket dispatcher requires a TCP listener");
    localUrl = `http://127.0.0.1:${address.port}/`;
    runtime.remotes.reverse.start(localUrl);
  });
  app.addHook("preClose", async () => {
    closeOwners();
    await runtime.remotes.reverse.close();
  });
}
