import type { FastifyInstance } from "fastify";
import { RpcChannel, RpcError, type RpcHandler } from "../shared/rpc";
import { authTokenExpiresAt, onAuthTokenLogout, verifyAuthToken } from "./auth";

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
      const token = request.cookies[credentials.cookieName]!;
      const channel = new RpcChannel(socket, {
        handle: async (operation, input, context) => {
          if (!verifyAuthToken(credentials.authSecret, token))
            throw new RpcError("UNAUTHORIZED", "Authentication required");
          return handle(operation, input, context);
        },
      });
      channels.add(channel);
      const stopLogout = onAuthTokenLogout(credentials.authSecret, token, () => channel.close());
      let expiryTimer: ReturnType<typeof setTimeout>;
      const expire = () => {
        const expiresAt = authTokenExpiresAt(credentials.authSecret, token);
        if (expiresAt === undefined) {
          channel.close();
          return;
        }
        // Node timers cannot represent a delay beyond signed 32-bit milliseconds.
        expiryTimer = setTimeout(expire, Math.min(expiresAt - Date.now(), 2 ** 31 - 1));
        expiryTimer.unref();
      };
      expire();
      void channel.closed.then(() => {
        clearTimeout(expiryTimer);
        stopLogout();
        channels.delete(channel);
      });
    },
  );
  return () => {
    for (const channel of channels) channel.close();
  };
}
