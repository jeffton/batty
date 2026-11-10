import type { FastifyInstance } from "fastify";
import { RpcChannel, RpcError, type RpcHandler } from "../shared/rpc-channel";
import { verifyAuthToken } from "./auth";

type OwnerCredentials = { authSecret: string; cookieName: string };

/** Owner and peer connections share framing, never their operation registries. */
export function registerOwnerSocket(
  app: FastifyInstance,
  credentials: OwnerCredentials,
  handle: RpcHandler,
): () => void {
  const channels = new Set<RpcChannel>();
  app.get(
    "/api/socket",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (request.headers.origin !== `${request.protocol}://${request.host}`)
          return reply.code(403).send({ error: "Same-origin socket required" });
        if (!verifyAuthToken(credentials.authSecret, request.cookies[credentials.cookieName]))
          return reply.code(401).send({ error: "Authentication required" });
      },
    },
    (socket, request) => {
      const token = request.cookies[credentials.cookieName];
      const channel = new RpcChannel(socket, {
        handle: async (operation, input, context) => {
          if (!verifyAuthToken(credentials.authSecret, token))
            throw new RpcError("UNAUTHORIZED", "Authentication required");
          return handle(operation, input, context);
        },
      });
      channels.add(channel);
      void channel.closed.then(() => channels.delete(channel));
    },
  );
  return () => {
    for (const channel of channels) channel.close();
  };
}
