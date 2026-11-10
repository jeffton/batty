import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { RemoteAccess, PairingClaim } from "../remote-access";
import { normalizeRemoteUrl } from "../remote-access";
import type { Runtime } from "../runtime";
import type { RemoteGrant } from "../../shared/remotes";

declare module "fastify" {
  interface FastifyRequest {
    nodeGrant?: RemoteGrant;
  }
}

/** Shared owner provisioning domain entry point, independent of HTTP or sockets. */
export async function executeRemoteOwnerOperation(
  runtime: Runtime,
  operation: string,
  input: { id?: string; url?: string; token?: string } = {},
) {
  const remotes = runtime.remotes;
  const access = remotes.access;
  switch (operation) {
    case "remotes.get":
      return {
        ...access.identity(),
        grants: access.listInvitations(),
        connections: access
          .listConnections()
          .map((connection) => ({ ...connection, status: remotes.reverse.status(connection.id) })),
      };
    case "remotes.token.list":
      return access.listInvitations();
    case "remotes.connection.list":
      return access.listConnections();
    case "remotes.token.generate":
      return access.issueInvitation();
    case "remotes.token.revoke":
      await access.revoke(input.id!);
      remotes.reverse.reconfigure();
      return { ok: true };
    case "remotes.connection.add": {
      const url = normalizeRemoteUrl(input.url!);
      if (!input.token?.trim()) throw new Error("Pairing token is required");
      if (access.completedPairing(url, input.token)) return { ok: true };
      const claim = await access.beginPairing(url, input.token);
      const response = await fetch(new URL("api/node/pair", url), {
        method: "POST",
        headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
        body: JSON.stringify(claim),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const detail = (await response.json()) as { message?: string; error?: string };
        throw new Error(
          `Pairing failed: ${detail.message ?? detail.error ?? `HTTP ${response.status}`}`,
        );
      }
      const identity = (await response.json()) as {
        instanceId: string;
        name: string;
        grantId: string;
      };
      await remotes.bindOrigin(identity.instanceId, identity.instanceId);
      await access.completePairing(url, input.token, identity);
      remotes.reverse.reconfigure();
      return { ok: true };
    }
    case "remotes.connection.remove": {
      const connection = access.getConnection(input.id!);
      const notification =
        connection?.localGrantId && remotes.reverse.hasControl(connection.id)
          ? remotes.reverse.notifyRemoval(connection).catch((error: unknown) => {
              console.error("Peer removal notification interrupted; local access revoked", error);
            })
          : undefined;
      await access.removeConnection(input.id!);
      remotes.disconnect(input.id!);
      remotes.reverse.reconfigure();
      await notification;
      return { ok: true };
    }
    default:
      throw new Error("Unknown remote provisioning operation");
  }
}

/** Owner routes provision links. Node routes have an independent bearer boundary, never owner access. */
export function authenticateNode(
  request: FastifyRequest,
  reply: FastifyReply,
  access: RemoteAccess,
) {
  const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (request.method === "POST" && request.url === "/api/node/pair") {
    if (bearer && access.canClaim(bearer)) return;
    return reply.code(401).send({ error: "Pairing token is invalid or has been used" });
  }
  request.nodeGrant = bearer ? access.authenticate(bearer) : undefined;
  if (!request.nodeGrant) return reply.code(401).send({ error: "Node authentication required" });
}

export function registerRemoteRoutes(app: FastifyInstance, runtime: Runtime) {
  const remotes = runtime.remotes;
  const access = remotes.access;
  app.get("/api/remotes", async () => ({
    ...access.identity(),
    grants: access.listInvitations(),
    connections: access.listConnections().map((connection) => ({
      ...connection,
      status: remotes.reverse.status(connection.id),
    })),
  }));
  app.post<{
    Body: {
      action: string;
      id?: string;
      url?: string;
      token?: string;
    };
  }>("/api/remotes", async (request) => {
    const input = request.body;
    const operation = {
      "token-list": "remotes.token.list",
      "connection-list": "remotes.connection.list",
      "token-generate": "remotes.token.generate",
      "token-revoke": "remotes.token.revoke",
      "connection-add": "remotes.connection.add",
      "connection-remove": "remotes.connection.remove",
    }[input.action];
    if (!operation) throw new Error("Unknown remote provisioning action");
    return executeRemoteOwnerOperation(runtime, operation, input);
  });
  app.post<{ Body: PairingClaim }>("/api/node/pair", async (request) => {
    const invitation = request.headers.authorization!.slice(7);
    const identity = await access.claimInvitation(invitation, request.body);
    await remotes.bindOrigin(request.body.instanceId, request.body.instanceId);
    remotes.reverse.reconfigure();
    return identity;
  });
}
