import fs from "node:fs/promises";
import path from "node:path";
import {
  BACKGROUND_CONTEXT as context,
  JsonlSessionRepo,
  laneConfig,
  branchTip,
  type AgentLane,
  type AgentMessage,
  type Entry,
  type JsonlSessionMetadata,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { SessionImageFileSystem } from "./session-images";

// Index reads use Pi's decoder without allowing Pi to repair or modify transcripts.
class SessionIndexReadFileSystem extends SessionImageFileSystem {
  override async writeFile(): Promise<never> {
    throw new Error("Session index reads cannot modify transcript files");
  }
  override async appendFile(): Promise<never> {
    throw new Error("Session index reads cannot modify transcript files");
  }
  override async renameFile(): Promise<never> {
    throw new Error("Session index reads cannot modify transcript files");
  }
  override async remove(): Promise<never> {
    throw new Error("Session index reads cannot modify transcript files");
  }
}

export interface SessionRead {
  metadata: JsonlSessionMetadata;
  entries: Entry[];
}

const repositories = new Map<string, JsonlSessionRepo>();
function repository(root: string): JsonlSessionRepo {
  root = path.resolve(root);
  let repo = repositories.get(root);
  if (!repo) {
    repo = new JsonlSessionRepo({
      sessionsRoot: root,
      fileSystem: new SessionImageFileSystem({ cwd: root }),
    });
    repositories.set(root, repo);
  }
  return repo;
}

/** Batty's synchronous presentation index. Pi alone writes and interprets session storage. */
export class HarnessSessionStore {
  private entries: Entry[] = [];
  private tip: string | null = null;
  private lane?: AgentLane;
  private static readonly owners = new Map<string, Promise<HarnessSessionStore>>();
  private static readonly reads = new Map<string, Promise<SessionRead>>();
  private static readonly listeners = new Set<(file: string, snapshot?: SessionRead) => void>();

  static subscribe(listener: (file: string, snapshot?: SessionRead) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishSummary(updatedAt = Date.now()): void {
    const snapshot = {
      metadata: { ...this.native.metadata, modifiedAt: updatedAt },
      entries: this.getEntries(),
    };
    for (const listener of HarnessSessionStore.listeners) listener(this.getSessionFile(), snapshot);
  }

  private constructor(
    readonly native: Session<JsonlSessionMetadata>,
    readonly repo: JsonlSessionRepo,
  ) {}

  static async create(
    cwd: string,
    root: string,
    parentSessionId?: string,
    id?: string,
  ): Promise<HarnessSessionStore> {
    const repo = repository(root);
    const native = await repo.create({ cwd, parentSessionId, id }, context);
    const store = new HarnessSessionStore(native, repo);
    this.owners.set(native.metadata.path, Promise.resolve(store));
    store.publishSummary();
    return store;
  }

  static async existing(
    cwd: string,
    root: string,
    id: string,
  ): Promise<HarnessSessionStore | undefined> {
    const metadata = (await repository(root).list({ cwd }, context)).find(
      (metadata) => metadata.id === id,
    );
    return metadata ? this.open(metadata.path) : undefined;
  }

  static async open(file: string): Promise<HarnessSessionStore> {
    file = await fs.realpath(file);
    const reading = this.reads.get(file);
    if (reading) await reading;
    const owner = this.owners.get(file);
    if (owner) return owner;
    let opened: Session<JsonlSessionMetadata> | undefined;
    const opening = (async () => {
      const metadata = await readHarnessSessionMetadata(file);
      const repo = repository(path.dirname(file));
      opened = await repo.open(metadata, context);
      const store = new HarnessSessionStore(opened, repo);
      await store.refresh();
      return store;
    })();
    this.owners.set(file, opening);
    try {
      return await opening;
    } catch (error) {
      try {
        await opened?.close(context);
      } finally {
        this.owners.delete(file);
      }
      throw error;
    }
  }

  static async read(file: string, options: { readOnly?: boolean } = {}): Promise<SessionRead> {
    file = await fs.realpath(file);
    const owner = this.owners.get(file);
    if (owner) {
      const store = await owner;
      return {
        metadata: store.native.metadata,
        entries: store.getEntries(),
      };
    }
    if (options.readOnly) {
      const metadata = await readHarnessSessionMetadata(file);
      const repo = new JsonlSessionRepo({
        sessionsRoot: path.dirname(file),
        fileSystem: new SessionIndexReadFileSystem({ cwd: path.dirname(file) }),
      });
      const native = await repo.open(metadata, context);
      try {
        return {
          metadata,
          entries: await native.findEntries({ order: "asc" }, context),
        };
      } finally {
        await native.close(context);
      }
    }
    const pending = this.reads.get(file);
    if (pending) return pending;
    const reading = (async () => {
      const metadata = await readHarnessSessionMetadata(file);
      const repo = repository(path.dirname(file));
      const native = await repo.open(metadata, context);
      try {
        return {
          metadata,
          entries: await native.findEntries({ order: "asc" }, context),
        };
      } finally {
        await native.close(context);
      }
    })();
    this.reads.set(file, reading);
    try {
      return await reading;
    } finally {
      this.reads.delete(file);
    }
  }

  async attach(lane: AgentLane): Promise<void> {
    if (this.lane) throw new Error(`Session already has a harness owner: ${this.getSessionId()}`);
    this.lane = lane;
    await this.refresh();
  }
  async refresh(): Promise<void> {
    this.entries = await this.native.findEntries({ order: "asc" }, context);
    this.tip = (await this.native.getValue(branchTip("main"), context))?.value ?? null;
    this.publishSummary((await fs.stat(this.getSessionFile())).mtimeMs);
  }
  observe(entry: Entry): void {
    if (!this.entries.some((candidate) => candidate.id === entry.id)) this.entries.push(entry);
    this.tip = entry.id;
    this.publishSummary();
  }
  setTip(tip: string | null): void {
    this.tip = tip;
  }
  getEntries(): Entry[] {
    return [...this.entries];
  }
  getBranch(): Entry[] {
    const entries = new Map(this.entries.map((entry) => [entry.id, entry]));
    const result: Entry[] = [];
    let id = this.tip;
    while (id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`Missing transcript entry ${id}`);
      result.push(entry);
      id = entry.parentId;
    }
    return result.reverse();
  }
  getLeafId(): string | null {
    return this.tip;
  }
  getLeafEntry(): Entry | undefined {
    return this.entries.find((entry) => entry.id === this.tip);
  }
  getSessionId(): string {
    return this.native.metadata.id;
  }
  getSessionFile(): string {
    return this.native.metadata.path;
  }
  async configuration() {
    return (await this.native.getValue(laneConfig("main"), context))?.value;
  }
  async appendCustomEntry(customType: string, data: unknown): Promise<string> {
    if (!this.lane) throw new Error("Attach a harness before writing session entries");
    return this.lane.appendCustomEntry(customType, data as never, context);
  }
  async appendMessage(message: AgentMessage): Promise<string> {
    if (!this.lane) throw new Error("Attach a harness before writing session messages");
    return this.lane.appendMessage(message, context);
  }
  async fork(
    root: string,
    leafId: string | null = this.tip,
    id?: string,
  ): Promise<HarnessSessionStore> {
    if (!leafId)
      return HarnessSessionStore.create(this.native.metadata.cwd!, root, this.getSessionId(), id);
    const repo = repository(root);
    const native = await repo.fork(
      this.native.metadata,
      { scope: "branch", branch: "main", entryId: leafId, id },
      context,
    );
    const store = new HarnessSessionStore(native, repo);
    await store.refresh();
    HarnessSessionStore.owners.set(native.metadata.path, Promise.resolve(store));
    return store;
  }
  release(): void {
    HarnessSessionStore.owners.delete(this.getSessionFile());
  }
}

/** Read the native session header without opening the repository. */
export async function readHarnessSessionMetadata(file: string): Promise<JsonlSessionMetadata> {
  const env = new NodeExecutionEnv({ cwd: path.dirname(file) });
  const lines = await env.readTextLines(file, { maxLines: 1 }, context);
  if (!lines.ok) throw lines.error;
  const header = JSON.parse(lines.value[0]!);
  if (header.v !== 4 || header.kind !== "header")
    throw new Error(`Unsupported session format: ${file}`);
  return { ...header, path: file, modifiedAt: (await fs.stat(file)).mtimeMs };
}
