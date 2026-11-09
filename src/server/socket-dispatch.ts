import type { FastifyInstance, FastifyRequest } from "fastify";
import { SocketChannel, type SocketHandler } from "../shared/socket-channel";
import type { RemoteConnectionCredentials } from "./remote-access";
import type { RemoteWorkers } from "./remote-workers";

export async function unpairPeer(remotes: RemoteWorkers, grantId: string) {
  const connection = remotes.access.pairedConnection(grantId);
  if (!connection) throw new Error("Unknown paired peer");
  await remotes.access.removeConnection(connection.id);
  remotes.disconnect(connection.id);
  setImmediate(() => remotes.reverse.reconfigure());
}
import { isNodeRoute } from "./reverse-transport";

/** Adapter to existing validated handlers. Only a fixed local app listener is
 * addressable; caller-supplied hosts, credentials and forwarding headers are not.
 * Keeping this adapter makes the experiment transport-only, not an API rewrite.
 */
export function localSocketHandler(
  localUrl: () => string,
  credentials: () => Record<string, string>,
  allowed: (path: string, method: string) => boolean,
): SocketHandler {
  return async (path, request) => {
    if (!allowed(path, request.method))
      return Response.json({ error: "Socket operation forbidden" }, { status: 403 });
    const headers = new Headers(credentials());
    for (const name of ["content-type", "x-batty-correlation-id"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    return fetch(new URL(path.slice(1), localUrl()), {
      method: request.method,
      headers,
      body: request.body,
      signal: request.signal,
      redirect: "error",
      ...(request.body ? { duplex: "half" } : {}),
    });
  };
}

export function isOwnerSocketRoute(path: string, method: string): boolean {
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) || !path.startsWith("/api/"))
    return false;
  const url = new URL(path, "http://batty.invalid");
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  if (url.pathname !== path.split("?")[0] || /[\\\0]/.test(decoded)) return false;
  if (decoded.split("/").some((part) => part === "." || part === "..")) return false;
  // Cookie ceremonies need real Set-Cookie responses; service control must never
  // gain loopback privilege, and node APIs have their own bearer-only socket.
  return !/^\/api\/(?:node|auth|service|socket|bootstrap|logout)(?:\/|$)/.test(decoded);
}

export function nodeSocketHandler(
  localUrl: () => string,
  connection: RemoteConnectionCredentials,
  remotes: RemoteWorkers,
): SocketHandler {
  const access = remotes.access;
  return async (path, request) => {
    const authorization = request.headers.get("authorization");
    const grant =
      authorization?.startsWith("Bearer ") && access.authenticate(authorization.slice(7));
    if (!grant || grant.id !== connection.localGrantId)
      return Response.json({ error: "Peer access removed" }, { status: 401 });
    // Revocation is durable once admitted, even if the transport closes before
    // the response. Do not cancel it through a loopback HTTP request.
    if (path === "/api/node/unpair" && request.method === "POST") {
      await unpairPeer(remotes, grant.id);
      return Response.json({ ok: true });
    }
    return localSocketHandler(
      localUrl,
      () => ({ authorization: authorization! }),
      (path, method) => path.startsWith("/api/node/") && isNodeRoute(path.slice(10), method),
    )(path, request);
  };
}

export function registerOwnerSocket(app: FastifyInstance, localUrl: () => string) {
  const channels = new Set<SocketChannel>();
  app.get(
    "/api/socket",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (request.headers.origin !== `${request.protocol}://${request.host}`)
          return reply.code(403).send({ error: "Same-origin socket required" });
      },
    },
    (socket, request: FastifyRequest) => {
      const channel = new SocketChannel(socket, {
        handle: localSocketHandler(
          localUrl,
          () => ({
            cookie: request.headers.cookie ?? "",
            origin: request.headers.origin!,
            "x-forwarded-host": request.host,
            "x-forwarded-proto": request.protocol,
          }),
          isOwnerSocketRoute,
        ),
      });
      channels.add(channel);
      void channel.closed.then(() => channels.delete(channel));
    },
  );
  return () => {
    for (const channel of channels) channel.close();
  };
}
