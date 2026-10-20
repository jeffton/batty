import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { stateDirPath } from "./options";

export interface RemoteGrant {
  id: string;
  label: string;
}

export interface RemoteConnection {
  id: string;
  label: string;
  url: string;
  instanceId?: string;
  grantId?: string;
}

export interface RemoteConnectionCredentials extends RemoteConnection {
  token: string;
}

interface StoredGrant extends RemoteGrant {
  tokenHash: string;
}

interface RemoteAccessState {
  instanceId: string;
  grants: StoredGrant[];
  connections: RemoteConnectionCredentials[];
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
  const { token: _token, ...result } = connection;
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

  identity(): { instanceId: string } {
    return { instanceId: this.state.instanceId };
  }

  issue(label: string): Promise<{ id: string; token: string }> {
    if (!label.trim()) return Promise.reject(new Error("Remote grant label is required"));
    return this.mutate((state) => {
      const id = crypto.randomUUID();
      const token = crypto.randomBytes(32).toString("base64url");
      state.grants.push({ id, label: label.trim(), tokenHash: hashToken(token) });
      return { id, token };
    });
  }

  revoke(id: string): Promise<void> {
    return this.mutate((state) => {
      state.grants = state.grants.filter((grant) => grant.id !== id);
    });
  }

  /** Receives the bearer token itself, without the HTTP Authorization scheme. */
  authenticate(bearer: string): RemoteGrant | undefined {
    const digest = Buffer.from(hashToken(bearer), "hex");
    const grant = this.state.grants.find((entry) =>
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
    };
    return this.mutate((state) => {
      if (state.connections.some((entry) => entry.id === normalized.id)) {
        throw new Error(`Remote connection already exists: ${normalized.id}`);
      }
      state.connections.push(normalized);
    });
  }

  removeConnection(id: string): Promise<void> {
    return this.mutate((state) => {
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
