import fs from "node:fs/promises";
import path from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  parseSessionEntries,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";

import { SESSION_TOOLS_CUSTOM_TYPE, type SessionTools } from "./session-metadata";

export interface SessionRead {
  metadata: SessionHeader & { path: string; modifiedAt: number };
  entries: SessionEntry[];
}

/** Validate before handing files to Pi, whose open operation can migrate old formats. */
async function readEntries(file: string) {
  const content = await fs.readFile(file, "utf8");
  const lines = content.split("\n").filter((line) => line.trim());
  const header = lines.length ? JSON.parse(lines[0]!) : undefined;
  if (header?.type !== "session" || header.version !== CURRENT_SESSION_VERSION)
    throw new Error(`Expected Pi session version ${CURRENT_SESSION_VERSION}: ${file}`);
  // Pi's parser skips malformed lines. Indexing must report incomplete histories instead.
  for (const line of lines) JSON.parse(line);
  return parseSessionEntries(content);
}

/** Presentation and ownership wrapper; Pi owns the tree, context projection, and persistence. */
export class SessionStore {
  private static readonly owners = new Map<string, Promise<SessionStore>>();
  private static readonly listeners = new Set<(file: string, snapshot?: SessionRead) => void>();

  private constructor(readonly native: SessionManager) {}

  static subscribe(listener: (file: string, snapshot?: SessionRead) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishSummary(updatedAt = Date.now()): void {
    const snapshot: SessionRead = {
      metadata: { ...this.native.getHeader()!, path: this.getSessionFile(), modifiedAt: updatedAt },
      entries: this.getEntries(),
    };
    for (const listener of SessionStore.listeners) listener(this.getSessionFile(), snapshot);
  }

  private static own(native: SessionManager): SessionStore {
    native.persistNow();
    const store = new SessionStore(native);
    this.owners.set(store.getSessionFile(), Promise.resolve(store));
    store.publishSummary();
    return store;
  }

  static async create(
    cwd: string,
    root: string,
    parentSessionId?: string,
    id?: string,
  ): Promise<SessionStore> {
    return this.own(SessionManager.create(cwd, root, { id, parentSession: parentSessionId }));
  }

  static async existing(cwd: string, root: string, id: string): Promise<SessionStore | undefined> {
    for (const owner of this.owners.values()) {
      const store = await owner;
      if (store.getSessionId() === id && store.native.getSessionDir() === path.resolve(root))
        return store;
    }
    const file = SessionManager.findById(cwd, id, root);
    return file ? this.open(file) : undefined;
  }

  static async open(file: string): Promise<SessionStore> {
    file = await fs.realpath(file);
    const owner = this.owners.get(file);
    if (owner) return owner;
    const opening = (async () => {
      await readEntries(file);
      return new SessionStore(SessionManager.open(file));
    })();
    this.owners.set(file, opening);
    try {
      return await opening;
    } catch (error) {
      this.owners.delete(file);
      throw error;
    }
  }

  static async read(file: string, _options: { readOnly?: boolean } = {}): Promise<SessionRead> {
    file = path.resolve(file);
    const owner = this.owners.get(file);
    if (owner) {
      const store = await owner;
      return {
        metadata: { ...store.native.getHeader()!, path: file, modifiedAt: Date.now() },
        entries: store.getEntries(),
      };
    }
    const entries = await readEntries(file);
    const native = SessionManager.inMemory(undefined, undefined, entries);
    return {
      metadata: { ...native.getHeader()!, path: file, modifiedAt: (await fs.stat(file)).mtimeMs },
      entries: native.getEntries(),
    };
  }

  getEntries(): SessionEntry[] {
    return this.native.getEntries();
  }
  getBranch(fromId?: string): SessionEntry[] {
    return this.native.getBranch(fromId);
  }
  getLeafId(): string | null {
    return this.native.getLeafId();
  }
  getLeafEntry(): SessionEntry | undefined {
    return this.native.getLeafEntry();
  }
  getSessionId(): string {
    return this.native.getSessionId();
  }
  getSessionFile(): string {
    return this.native.getSessionFile()!;
  }
  async configuration() {
    const context = this.native.buildSessionContext();
    const branch = this.getBranch();
    const thinking = branch.findLast((entry) => entry.type === "thinking_level_change");
    const tools = branch.findLast(
      (entry) => entry.type === "custom" && entry.customType === SESSION_TOOLS_CUSTOM_TYPE,
    );
    return {
      model: context.model ?? undefined,
      thinkingLevel: thinking?.type === "thinking_level_change" ? context.thinkingLevel : undefined,
      activeToolNames:
        tools?.type === "custom" ? (tools.data as SessionTools).activeToolNames : undefined,
    };
  }
  async appendCustomEntry(customType: string, data: unknown): Promise<string> {
    const id = this.native.appendCustomEntry(customType, data);
    this.publishSummary();
    return id;
  }
  async appendMessage(message: Parameters<SessionManager["appendMessage"]>[0]): Promise<string> {
    const id = this.native.appendMessage(message);
    this.publishSummary();
    return id;
  }
  async fork(
    root: string,
    leafId: string | null = this.getLeafId(),
    id?: string,
  ): Promise<SessionStore> {
    return SessionStore.own(
      SessionManager.forkFrom(this.getSessionFile(), this.native.getCwd(), root, { id, leafId }),
    );
  }
  release(): void {
    SessionStore.owners.delete(this.getSessionFile());
  }
}
