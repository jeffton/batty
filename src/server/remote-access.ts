import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { stateDirPath } from "./options";

import type { RemoteConnection, RemoteGrant } from "../shared/remotes";

export interface RemoteConnectionCredentials extends RemoteConnection {
  token: string;
  /** Local incoming credential belonging exclusively to this peer. */
  localGrantId?: string;
  invitationHash?: string;
  claimHash?: string;
}

interface StoredGrant extends RemoteGrant {
  tokenHash: string;
  invitation?: boolean;
  instanceId?: string;
}

interface RemoteAccessState {
  instanceId: string;
  grants: StoredGrant[];
  connections: RemoteConnectionCredentials[];
  pendingPairings?: PendingPairing[];
}

export interface PairingClaim {
  instanceId: string;
  name: string;
  url: string;
  localGrantId: string;
  localToken: string;
  remoteToken: string;
}
interface PendingPairing {
  url: string;
  invitationHash: string;
  claim: PairingClaim;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function normalizeRemoteUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Remote connections require HTTPS (HTTP is allowed only on loopback)");
  }
  if (url.username || url.password || url.search || url.hash || /[?#]/.test(value)) {
    throw new Error("Remote connection URLs cannot contain credentials, a query, or a fragment");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.href;
}

function publicConnection(connection: RemoteConnectionCredentials): RemoteConnection {
  const {
    token: _token,
    localGrantId: _local,
    invitationHash: _invite,
    claimHash: _claim,
    ...result
  } = connection;
  return result;
}

/** Installation-local node grants and outgoing credentials; never uses the owner authSecret. */
export class RemoteAccess {
  private pending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private state: RemoteAccessState,
  ) {}

  static async open(battyDir: string): Promise<RemoteAccess> {
    const directory = stateDirPath(battyDir);
    await fs.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, "remote-access.json");
    let state: RemoteAccessState;
    try {
      state = JSON.parse(await fs.readFile(filePath, "utf8")) as RemoteAccessState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const access = new RemoteAccess(filePath, {
        instanceId: crypto.randomUUID(),
        grants: [],
        connections: [],
      });
      await access.persist(access.state);
      return access;
    }
    await fs.chmod(filePath, 0o600);
    return new RemoteAccess(filePath, state);
  }

  identity(): { instanceId: string; name: string } {
    return {
      instanceId: this.state.instanceId,
      name: `${os.hostname()} · ${this.state.instanceId.slice(0, 8)}`,
    };
  }

  /** Invitations authorize only one exact pairing claim, never agent operations. */
  issueInvitation(): Promise<{ id: string; token: string }> {
    return this.mutate((state) => {
      const id = crypto.randomUUID();
      const token = crypto.randomBytes(32).toString("base64url");
      state.grants.push({
        id,
        label: "Unused token",
        tokenHash: hashToken(token),
        invitation: true,
      });
      return { id, token };
    });
  }

  listInvitations(): RemoteGrant[] {
    return this.state.grants
      .filter((grant) => grant.invitation)
      .map(({ id, label }) => ({ id, label }));
  }

  canClaim(token: string): boolean {
    const digest = hashToken(token);
    return (
      this.state.grants.some((grant) => grant.invitation && grant.tokenHash === digest) ||
      this.state.connections.some((connection) => connection.invitationHash === digest)
    );
  }

  completedPairing(url: string, invitation: string): boolean {
    return this.state.connections.some(
      (connection) => connection.url === url && connection.claimHash === hashToken(invitation),
    );
  }

  beginPairing(url: string, invitation: string, localUrl: string): Promise<PairingClaim> {
    return this.mutate((state) => {
      const invitationHash = hashToken(invitation);
      const existing = state.pendingPairings?.find(
        (pairing) => pairing.url === url && pairing.invitationHash === invitationHash,
      );
      if (existing) return structuredClone(existing.claim);
      const claim: PairingClaim = {
        ...this.identity(),
        url: normalizeRemoteUrl(localUrl),
        localGrantId: crypto.randomUUID(),
        localToken: crypto.randomBytes(32).toString("base64url"),
        remoteToken: crypto.randomBytes(32).toString("base64url"),
      };
      (state.pendingPairings ??= []).push({ url, invitationHash, claim });
      return structuredClone(claim);
    });
  }

  claimInvitation(
    invitation: string,
    claim: PairingClaim,
  ): Promise<{ instanceId: string; name: string; grantId: string }> {
    return this.mutate((state) => {
      if (
        !claim.instanceId?.trim() ||
        !claim.name?.trim() ||
        !claim.localGrantId?.trim() ||
        !/^[A-Za-z0-9_-]{43}$/.test(claim.localToken) ||
        !/^[A-Za-z0-9_-]{43}$/.test(claim.remoteToken)
      )
        throw new Error("Invalid pairing claim");
      const url = normalizeRemoteUrl(claim.url);
      if (claim.instanceId === state.instanceId)
        throw new Error("Cannot connect a Batty instance to itself");
      const invitationHash = hashToken(invitation);
      const claimHash = hashToken(JSON.stringify(claim));
      const prior = state.connections.find(
        (connection) => connection.invitationHash === invitationHash,
      );
      if (prior) {
        if (prior.claimHash !== claimHash) throw new Error("Pairing token has already been used");
        return { ...this.identity(), grantId: prior.localGrantId! };
      }
      if (state.connections.some((connection) => connection.instanceId === claim.instanceId))
        throw new Error("This remote instance is already connected");
      const invitationGrant = state.grants.find(
        (grant) => grant.invitation && grant.tokenHash === invitationHash,
      );
      if (!invitationGrant) throw new Error("Pairing token is invalid or has been used");
      const connection: RemoteConnectionCredentials = {
        id: claim.instanceId,
        label: claim.name,
        instanceId: claim.instanceId,
        url,
        token: claim.localToken,
        grantId: claim.localGrantId,
        transport: "reverse",
        reverseGrantId: invitationGrant.id,
        localGrantId: invitationGrant.id,
        invitationHash,
        claimHash,
      };
      this.validateConnection(state, connection);
      state.grants = state.grants.filter((grant) => grant.id !== invitationGrant.id);
      state.grants.push({
        id: invitationGrant.id,
        label: claim.name,
        tokenHash: hashToken(claim.remoteToken),
        instanceId: claim.instanceId,
      });
      state.connections.push(connection);
      return { ...this.identity(), grantId: invitationGrant.id };
    });
  }

  completePairing(
    url: string,
    invitation: string,
    identity: { instanceId: string; name: string; grantId: string },
  ): Promise<string> {
    return this.mutate((state) => {
      const invitationHash = hashToken(invitation);
      const completed = state.connections.find(
        (connection) => connection.url === url && connection.claimHash === invitationHash,
      );
      if (completed) return completed.id;
      const pending = state.pendingPairings?.find(
        (pairing) => pairing.url === url && pairing.invitationHash === invitationHash,
      );
      if (!pending) throw new Error("No pending pairing claim");
      if (!identity.instanceId?.trim() || !identity.name?.trim() || !identity.grantId?.trim())
        throw new Error("Invalid remote identity");
      if (state.connections.some((connection) => connection.instanceId === identity.instanceId))
        throw new Error("This remote instance is already connected");
      const connection: RemoteConnectionCredentials = {
        id: identity.instanceId,
        instanceId: identity.instanceId,
        label: identity.name,
        url,
        token: pending.claim.remoteToken,
        grantId: identity.grantId,
        localGrantId: pending.claim.localGrantId,
        reverseDial: true,
        claimHash: invitationHash,
      };
      this.validateConnection(state, connection);
      state.grants.push({
        id: pending.claim.localGrantId,
        label: identity.name,
        tokenHash: hashToken(pending.claim.localToken),
        instanceId: identity.instanceId,
      });
      state.connections.push(connection);
      state.pendingPairings = state.pendingPairings!.filter((pairing) => pairing !== pending);
      return connection.id;
    });
  }

  pairedConnection(grantId: string): RemoteConnectionCredentials | undefined {
    const connection = this.state.connections.find((item) => item.localGrantId === grantId);
    return connection && { ...connection };
  }

  revoke(id: string): Promise<void> {
    return this.mutate((state) => {
      state.grants = state.grants.filter((grant) => grant.id !== id);
    });
  }

  /** Receives the bearer token itself, without the HTTP Authorization scheme. */
  authenticate(bearer: string): RemoteGrant | undefined {
    const digest = Buffer.from(hashToken(bearer), "hex");
    const grant = this.state.grants.find(
      (entry) =>
        !entry.invitation &&
        !!entry.instanceId &&
        this.state.connections.some(
          (connection) =>
            connection.localGrantId === entry.id && connection.instanceId === entry.instanceId,
        ) &&
        crypto.timingSafeEqual(Buffer.from(entry.tokenHash, "hex"), digest),
    );
    return grant ? { id: grant.id, label: grant.label } : undefined;
  }

  listGrants(): RemoteGrant[] {
    return this.state.grants.map(({ id, label }) => ({ id, label }));
  }

  listConnections(): RemoteConnection[] {
    return this.state.connections.map(publicConnection);
  }

  /** Internal transport use only: includes the remote-issued bearer token. */
  getConnection(id: string): RemoteConnectionCredentials | undefined {
    const connection = this.state.connections.find((entry) => entry.id === id);
    return connection ? { ...connection } : undefined;
  }

  async addConnection(connection: RemoteConnectionCredentials): Promise<void> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(connection.id)) {
      return Promise.reject(
        new Error("Remote connection ID must contain only letters, digits, _ or -"),
      );
    }
    if (!connection.label.trim() || !connection.token.trim()) {
      return Promise.reject(new Error("Remote connection label and token are required"));
    }
    const normalized: RemoteConnectionCredentials = {
      id: connection.id,
      label: connection.label.trim(),
      url: normalizeRemoteUrl(connection.url),
      token: connection.token,
      ...(connection.instanceId === undefined ? {} : { instanceId: connection.instanceId }),
      ...(connection.grantId === undefined ? {} : { grantId: connection.grantId }),
      ...(connection.transport === undefined ? {} : { transport: connection.transport }),
      ...(connection.reverseDial === undefined ? {} : { reverseDial: connection.reverseDial }),
      ...(connection.reverseGrantId === undefined
        ? {}
        : { reverseGrantId: connection.reverseGrantId }),
    };
    return this.mutate((state) => {
      if (state.connections.some((entry) => entry.id === normalized.id)) {
        throw new Error(`Remote connection already exists: ${normalized.id}`);
      }
      this.validateConnection(state, normalized);
      state.connections.push(normalized);
    });
  }

  updateIdentity(id: string, identity: { instanceId: string; grantId: string }): Promise<void> {
    return this.mutate((state) => {
      const connection = state.connections.find((entry) => entry.id === id);
      if (!connection) throw new Error(`Unknown remote instance: ${id}`);
      if (!identity.instanceId.trim() || !identity.grantId.trim())
        throw new Error("Remote identity and grant ID are required");
      if (connection.instanceId && connection.instanceId !== identity.instanceId)
        throw new Error("Remote installation identity changed");
      const updated = { ...connection, ...identity };
      this.validateConnection(state, updated);
      Object.assign(connection, identity);
    });
  }

  private validateConnection(
    state: RemoteAccessState,
    connection: RemoteConnectionCredentials,
  ): void {
    if (connection.transport !== undefined && connection.transport !== "reverse")
      throw new Error("Unknown remote transport");
    if (connection.reverseDial !== undefined && typeof connection.reverseDial !== "boolean")
      throw new Error("Reverse connection setting must be a boolean");
    if (connection.instanceId === state.instanceId)
      throw new Error("Cannot connect a Batty instance to itself");
    if (
      connection.instanceId &&
      state.connections.some(
        (entry) => entry.id !== connection.id && entry.instanceId === connection.instanceId,
      )
    )
      throw new Error("This remote instance is already connected");
    if (connection.transport === "reverse") {
      if (!connection.instanceId?.trim())
        throw new Error("Reverse connections require a remote installation ID");
      if (connection.reverseDial)
        throw new Error("An incoming reverse connection cannot also dial");
      if (!state.grants.some((grant) => grant.id === connection.reverseGrantId))
        throw new Error("Select an existing incoming access grant for this reverse connection");
      if (
        state.connections.some(
          (entry) =>
            entry.id !== connection.id &&
            entry.transport === "reverse" &&
            entry.reverseGrantId === connection.reverseGrantId,
        )
      )
        throw new Error("This incoming access grant is already bound to a reverse connection");
    } else if (connection.reverseGrantId !== undefined) {
      throw new Error("Incoming access bindings require reverse transport");
    }
  }

  removeConnection(id: string): Promise<void> {
    return this.mutate((state) => {
      const connection = state.connections.find((item) => item.id === id);
      if (connection?.localGrantId)
        state.grants = state.grants.filter((grant) => grant.id !== connection.localGrantId);
      state.connections = state.connections.filter((connection) => connection.id !== id);
    });
  }

  private mutate<T>(change: (state: RemoteAccessState) => T): Promise<T> {
    const result = this.pending.then(async () => {
      const next = structuredClone(this.state);
      const value = change(next);
      await this.persist(next);
      this.state = next;
      return value;
    });
    // Keep later writes usable after failure; callers still receive the original rejection.
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async persist(state: RemoteAccessState): Promise<void> {
    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporary, this.filePath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
