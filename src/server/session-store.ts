import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import {
  convertToLlm,
  type ModelRuntime,
  type SessionEntry,
  type SessionHeader,
  type SessionTreeNode,
  type SessionProjection,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  AgentDoc,
  Harness,
  ROOT_CONVERSATION_ID,
  createRegistry,
  defineDoc,
  type AgentState,
  type Conversation,
  type ConversationInit,
  type ContextView,
  type CommitPublication,
  type SubmissionId,
  type Cursor,
  type EntryDraft,
  type EntryId,
  type EntryRecord,
  type HarnessSettings,
  type ModelRef,
  type Storage,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SESSION_TOOLS_CUSTOM_TYPE, type SessionTools } from "./session-metadata";
import { projectEntries } from "./session-projection";

const context = BACKGROUND_CONTEXT;
type Metadata = {
  id: string;
  cwd: string;
  parentSession: string | null;
  name: string | null;
  timestamp: string;
};
export const SessionMetadataDoc = defineDoc<Metadata>({
  kind: "batty.session",
  version: 1,
  scope: "session",
  initial: () => ({ id: "", cwd: "", parentSession: null, name: null, timestamp: "" }),
});
export interface SessionRead {
  metadata: SessionHeader & { path: string; modifiedAt: number };
  entries: SessionEntry[];
}
export interface SessionConfiguration {
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  activeToolNames?: string[];
}
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value));
}
function messageDraft(message: AgentMessage): EntryDraft {
  return {
    kind:
      message.role === "custom"
        ? "batty.custom-message"
        : message.role === "toolResult"
          ? "pi.tool-result"
          : `pi.${message.role}`,
    model: convertToLlm([message]),
    data:
      message.role === "custom"
        ? json({
            customType: message.customType,
            content: message.content,
            display: message.display,
            details: message.details,
            timestamp: message.timestamp,
          })
        : json({
            clientMessageId: (message as AgentMessage & { clientMessageId?: string })
              .clientMessageId,
          }),
  };
}
function latestModifiedAt(records: readonly EntryRecord[], fileMtime: number): number {
  return records.reduce(
    (latest, record) =>
      (record.model ?? []).reduce((value, message) => Math.max(value, message.timestamp), latest),
    fileMtime,
  );
}

async function assertModern(file: string): Promise<void> {
  const handle = await fs.open(file, "r");
  try {
    const header = Buffer.alloc(16);
    await handle.read(header, 0, 16, 0);
    if (header.toString() !== "SQLite format 3\0")
      throw new Error(`Expected durable SQLite session: ${file}`);
  } finally {
    await handle.close();
  }
}

async function history(conversation: Conversation): Promise<EntryRecord[]> {
  const records: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({}, 500, cursor, context);
    records.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return records.reverse();
}

type SessionOwner = {
  promise: Promise<SessionStore>;
  retained: boolean;
  leases: number;
  closing?: Promise<void>;
  drained?: () => void;
};

/** Owns one SQLite writer and its paused-until-admitted durable Harness. */
export class SessionStore {
  private static readonly owners = new Map<string, SessionOwner>();
  private static readonly listeners = new Set<(file: string, snapshot?: SessionRead) => void>();
  readonly registry: ReturnType<typeof createRegistry>;
  readonly harness: Harness;
  readonly conversation: Conversation;
  private entries: SessionEntry[] = [];
  private records: EntryRecord[] = [];
  private submissions = new Map<SubmissionId, SubmissionRecord>();
  private projectionDirty = false;
  private unsubscribeCommits?: () => void;
  private refreshing: Promise<void> = Promise.resolve();
  private contextView!: ContextView;
  private agentState: Readonly<AgentState> = {};
  private metadata!: Metadata;
  private closing?: Promise<void>;

  private constructor(
    readonly storage: Storage,
    harness: Harness,
    conversation: Conversation,
    private readonly file: string,
    private readonly unlock: () => Promise<void>,
    registry: ReturnType<typeof createRegistry>,
    runtime: { value?: { models: ModelRuntime; settings: HarnessSettings } },
  ) {
    this.harness = harness;
    this.conversation = conversation;
    this.registry = registry;
    this.runtimeSlot = runtime;
  }
  private readonly runtimeSlot: { value?: { models: ModelRuntime; settings: HarnessSettings } };

  configureRuntime(runtime: { models: ModelRuntime; settings: HarnessSettings }): void {
    this.runtimeSlot.value = runtime;
  }

  static subscribe(listener: (file: string, snapshot?: SessionRead) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publishSummary(updatedAt = Date.now()): void {
    const snapshot = this.snapshot(updatedAt);
    for (const listener of SessionStore.listeners) listener(this.file, snapshot);
  }
  private snapshot(modifiedAt: number): SessionRead {
    return {
      metadata: {
        ...this.getHeader(),
        path: this.file,
        modifiedAt: latestModifiedAt(this.records, modifiedAt),
      },
      entries: this.getEntries(),
    };
  }

  private static async load(
    file: string,
    metadata?: Metadata,
    init?: ConversationInit,
  ): Promise<SessionStore> {
    const unlock = await lockfile.lock(file, { realpath: false, retries: 0 });
    let storage: Storage | undefined;
    let harness: Harness | undefined;
    try {
      storage = await openNodeSqliteStorage(file);
      const registry = createRegistry();
      const runtime: { value?: { models: ModelRuntime; settings: HarnessSettings } } = {};
      const models = new Proxy({} as ModelRuntime, {
        get(_target, key) {
          if (!runtime.value) throw new Error("Session runtime is not configured");
          const value = Reflect.get(runtime.value.models, key);
          return typeof value === "function" ? value.bind(runtime.value.models) : value;
        },
      });
      harness = await Harness.open(
        storage,
        {
          registry,
          models,
          get settings() {
            return runtime.value?.settings;
          },
        },
        context,
      );
      if (!metadata && !(await harness.snapshot(SessionMetadataDoc, context))?.id)
        throw new Error(`Expected modern durable session metadata: ${file}`);
      const conversation = await harness.root(
        context,
        metadata
          ? {
              init: async (tx, id) => {
                Object.assign(await tx.doc(SessionMetadataDoc), metadata);
                (await tx.doc(AgentDoc, id)).cwd = metadata.cwd;
                await init?.(tx, id);
              },
            }
          : undefined,
      );
      const store = new SessionStore(
        storage,
        harness,
        conversation,
        file,
        unlock,
        registry,
        runtime,
      );
      await store.hydrate();
      store.unsubscribeCommits = harness.subscribeCommits((publication) =>
        store.adopt(publication),
      );
      return store;
    } catch (error) {
      try {
        if (harness) await harness.close(context);
        else await storage?.close(context);
      } finally {
        await unlock();
      }
      throw error;
    }
  }

  private static async createInitialized(
    cwd: string,
    root: string,
    parentSession: string | undefined,
    id: string,
    init?: ConversationInit,
  ): Promise<SessionStore> {
    root = path.resolve(root);
    await fs.mkdir(root, { recursive: true });
    root = await fs.realpath(root);
    const timestamp = new Date().toISOString();
    const file = path.join(root, `${timestamp.replaceAll(":", "-")}_${id}.sqlite`);
    const pending = this.load(
      file,
      { id, cwd: path.resolve(cwd), parentSession: parentSession ?? null, name: null, timestamp },
      init,
    );
    const owner: SessionOwner = { promise: pending, retained: true, leases: 0 };
    this.owners.set(file, owner);
    try {
      const store = await pending;
      store.publishSummary();
      return store;
    } catch (error) {
      if (this.owners.get(file) === owner) this.owners.delete(file);
      throw error;
    }
  }
  static create(
    cwd: string,
    root: string,
    parentSessionId?: string,
    id: string = randomUUID(),
  ): Promise<SessionStore> {
    return this.createInitialized(cwd, root, parentSessionId, id);
  }
  static async existing(cwd: string, root: string, id: string): Promise<SessionStore | undefined> {
    root = path.resolve(root);
    for (const owner of this.owners.values()) {
      if (owner.closing) continue;
      const store = await owner.promise;
      if (
        store.getSessionId() === id &&
        store.getSessionDir() === root &&
        store.getCwd() === path.resolve(cwd)
      )
        return this.open(store.getSessionFile());
    }
    let files: string[];
    try {
      files = await fs.readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const file = files.find((file) => file.endsWith(`_${id}.sqlite`));
    return file ? this.open(path.join(root, file)) : undefined;
  }
  private static async acquire(
    file: string,
    retained: boolean,
    leased: boolean,
  ): Promise<SessionOwner> {
    for (;;) {
      let owner = this.owners.get(file);
      if (owner?.closing) {
        await owner.closing;
        continue;
      }
      if (!owner) {
        const promise = (async () => {
          await assertModern(file);
          return this.load(file);
        })();
        owner = { promise, retained: false, leases: 0 };
        this.owners.set(file, owner);
        const opening = owner;
        void promise.catch(() => {
          if (this.owners.get(file) === opening) this.owners.delete(file);
        });
      }
      if (retained) owner.retained = true;
      if (leased) owner.leases++;
      return owner;
    }
  }
  /** Retain a writer for a controller until explicit close/release. */
  static async open(file: string): Promise<SessionStore> {
    file = await fs.realpath(file);
    return (await this.acquire(file, true, false)).promise;
  }
  /** Borrow a source for this callback; an otherwise unretained writer closes after its last borrower. */
  static async withSource<T>(file: string, use: (source: SessionStore) => Promise<T>): Promise<T> {
    file = await fs.realpath(file);
    const owner = await this.acquire(file, false, true);
    let source: SessionStore | undefined;
    try {
      source = await owner.promise;
      return await use(source);
    } finally {
      owner.leases--;
      if (owner.leases === 0) {
        owner.drained?.();
        if (!owner.retained && source) await source.close();
      }
    }
  }
  static async inspectRecovery(
    file: string,
  ): Promise<{ pending: boolean; parentSession?: string }> {
    const storage = await openNodeSqliteStorage(file);
    try {
      const tasks = await Promise.all(
        ["pending", "running", "waiting", "completing"].map((status) =>
          storage.scanTasks(
            { status: status as "pending" | "running" | "waiting" | "completing" },
            1,
            undefined,
            context,
          ),
        ),
      );
      const submissions = await Promise.all(
        ["queued", "placed"].map((status) =>
          storage.scanSubmissions({ status: status as "queued" | "placed" }, 1, undefined, context),
        ),
      );
      const document = await storage.findDocument(
        { scope: { kind: "session" }, kind: "batty.session" },
        "current",
        context,
      );
      const metadata = document && (await storage.document(document.id, "current", context));
      if (!metadata) throw new Error(`Session has no metadata: ${file}`);
      const parent = (metadata.value as Metadata).parentSession;
      return {
        pending: [...tasks, ...submissions].some((page) => page.items.length > 0),
        ...(parent ? { parentSession: parent } : {}),
      };
    } finally {
      await storage.close(context);
    }
  }

  static async read(file: string, _options: { readOnly?: boolean } = {}): Promise<SessionRead> {
    file = await fs.realpath(file);
    const owner = this.owners.get(file);
    if (owner) {
      return this.withSource(file, async (store) => {
        await store.refresh();
        return store.snapshot((await fs.stat(file)).mtimeMs);
      });
    }
    await assertModern(file);
    const storage = await openNodeSqliteStorage(file);
    try {
      const metadataRecord = await storage.findDocument(
        { scope: { kind: "session" }, kind: "batty.session" },
        "current",
        context,
      );
      const metadata =
        metadataRecord && (await storage.document(metadataRecord.id, "current", context));
      if (metadata?.version !== 1 || !metadata.value.id)
        throw new Error(`Expected modern durable session metadata: ${file}`);
      const records: EntryRecord[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanEntries(
          { conversationId: ROOT_CONVERSATION_ID },
          500,
          cursor,
          context,
        );
        records.push(...page.items);
        cursor = page.next;
      } while (cursor);
      const submissions = [];
      cursor = undefined;
      do {
        const page = await storage.scanSubmissions(
          { conversationId: ROOT_CONVERSATION_ID },
          500,
          cursor,
          context,
        );
        submissions.push(...page.items);
        cursor = page.next;
      } while (cursor);
      return {
        metadata: {
          ...header(metadata.value as Metadata),
          path: file,
          modifiedAt: latestModifiedAt(records, (await fs.stat(file)).mtimeMs),
        },
        entries: projectEntries(records.reverse(), submissions),
      };
    } finally {
      await storage.close(context);
    }
  }

  refresh(): Promise<void> {
    const next = this.refreshing.then(
      () => this.refreshContext(),
      () => this.refreshContext(),
    );
    this.refreshing = next;
    return next;
  }
  private adopt(publication: CommitPublication): void {
    for (const change of publication.changes) {
      if (change.type === "entry" && change.value.conversationId === this.conversation.id) {
        this.records.push(change.value);
        this.projectionDirty = true;
      } else if (
        change.type === "submission" &&
        change.value.conversationId === this.conversation.id
      ) {
        this.submissions.set(change.value.id, change.value);
        this.projectionDirty = true;
      } else if (change.type === "document" && change.value !== null) {
        if (change.record.kind === SessionMetadataDoc.definition.kind)
          this.metadata = change.value as Metadata;
        else if (
          change.record.kind === AgentDoc.definition.kind &&
          change.conversationId === this.conversation.id
        )
          this.agentState = change.value as AgentState;
      }
    }
  }
  private project(): SessionEntry[] {
    if (this.projectionDirty) {
      this.entries = projectEntries(this.records, [...this.submissions.values()]);
      this.projectionDirty = false;
    }
    return this.entries;
  }
  getSubmissionRecord(id: SubmissionId): SubmissionRecord | undefined {
    return this.submissions.get(id);
  }
  getEntriesUpTo(entryId: number): SessionEntry[] {
    return projectEntries(
      this.records.filter((record) => record.id <= entryId),
      [...this.submissions.values()],
    );
  }
  private async refreshContext(): Promise<void> {
    this.contextView = await this.conversation.context(context);
  }
  private async hydrate(): Promise<void> {
    const contextView = await this.conversation.context(context);
    const records = await history(this.conversation);
    const submissions = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanSubmissions(
        { conversationId: this.conversation.id },
        500,
        cursor,
        context,
      );
      submissions.push(...page.items);
      cursor = page.next;
    } while (cursor);
    const metadata = await this.harness.snapshot(SessionMetadataDoc, context);
    const agentState = await this.harness.snapshot(AgentDoc, this.conversation.id, context);
    this.contextView = contextView;
    this.agentState = agentState ?? {};
    this.records = records;
    this.submissions = new Map(submissions.map((record) => [record.id, record]));
    this.entries = projectEntries(records, submissions);
    this.metadata = metadata as Metadata;
  }
  getEntries(): SessionEntry[] {
    return structuredClone(this.project());
  }
  getBranch(fromId: string | null = this.getLeafId()): SessionEntry[] {
    if (fromId === null) return [];
    const entries = this.project();
    const index = entries.findIndex((entry) => entry.id === fromId);
    if (index < 0) throw new Error(`Unknown session entry: ${fromId}`);
    return structuredClone(entries.slice(0, index + 1));
  }
  getLeafId(): string | null {
    return this.project().at(-1)?.id ?? null;
  }
  getLeafEntry(): SessionEntry | undefined {
    return this.getEntries().at(-1);
  }
  getSessionId(): string {
    return this.metadata.id;
  }
  getSessionFile(): string {
    return this.file;
  }
  getSessionDir(): string {
    return path.dirname(this.file);
  }
  getCwd(): string {
    return this.metadata.cwd;
  }
  getHeader(): SessionHeader {
    return header(this.metadata);
  }
  getEntry(id: string): SessionEntry | undefined {
    return this.getEntries().find((entry) => entry.id === id);
  }
  getSessionName(): string | undefined {
    return this.metadata.name ?? undefined;
  }
  getLabel(id: string): string | undefined {
    const label = this.project().findLast(
      (entry) => entry.type === "label" && entry.targetId === id,
    );
    return label?.type === "label" ? (label.label ?? undefined) : undefined;
  }
  getTree(): SessionTreeNode[] {
    const roots: SessionTreeNode[] = [];
    const nodes = new Map<string, SessionTreeNode>();
    for (const entry of this.getEntries()) {
      const node: SessionTreeNode = { entry, children: [], label: this.getLabel(entry.id) };
      nodes.set(entry.id, node);
      const parent = entry.parentId && nodes.get(entry.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }
  buildContextEntries(): SessionEntry[] {
    const active = new Set(this.contextView.entries.map((entry) => String(entry.id)));
    return this.getEntries().filter((entry) => active.has(entry.id.split(":")[0]!));
  }
  buildSessionProjection(): SessionProjection {
    const byId = new Map(this.getEntries().map((entry) => [entry.id, entry]));
    const entries = this.contextView.entries.map((entry, index) => {
      const sourceEntry = byId.get(String(entry.id))!;
      let messages: AgentMessage[];
      if (sourceEntry.type === "custom_message") {
        messages = [
          {
            role: "custom",
            customType: sourceEntry.customType,
            content: sourceEntry.content,
            display: sourceEntry.display,
            details: sourceEntry.details,
            timestamp: Date.parse(sourceEntry.timestamp),
          },
        ];
      } else {
        // Error and interrupted assistants belong to the transcript, not the provider context.
        const contribution =
          sourceEntry.type === "message" &&
          sourceEntry.message.role === "assistant" &&
          ["aborted", "error", "deferred"].includes(sourceEntry.message.stopReason)
            ? [sourceEntry.message]
            : this.contextView.contributions[index]!;
        messages = contribution.map((message, messageIndex) => {
          const source = byId.get(messageIndex ? `${entry.id}:${messageIndex}` : String(entry.id));
          if (source?.type !== "message") return structuredClone(message) as AgentMessage;
          const presentation = source.message as AgentMessage & { clientMessageId?: string };
          return {
            ...structuredClone(message),
            ...(presentation.clientMessageId
              ? { clientMessageId: presentation.clientMessageId }
              : {}),
            ...(message.role === "toolResult" && presentation.role === "toolResult"
              ? { details: presentation.details }
              : {}),
          } as AgentMessage;
        });
      }
      return { sourceEntry, messages };
    });
    return {
      entries,
      messages: entries.flatMap((entry) => entry.messages),
      model: this.agentState.model ?? null,
      thinkingLevel: this.agentState.thinkingLevel ?? "off",
    };
  }
  async observeEntries(_entries: readonly EntryRecord[]): Promise<void> {
    await this.refresh();
    this.publishSummary();
  }
  async setSessionName(name: string): Promise<void> {
    await this.conversation.commit(async (tx) => {
      (await tx.doc(SessionMetadataDoc)).name = name;
      await tx.appendEntry(this.conversation.id, { kind: "batty.session-info", data: { name } });
    }, context);
    await this.refresh();
    this.publishSummary();
  }
  async setLabel(targetId: string, label: string | undefined): Promise<void> {
    if (!this.getEntry(targetId)) throw new Error(`Unknown session entry: ${targetId}`);
    await this.conversation.commit(
      (tx) =>
        tx.appendEntry(this.conversation.id, {
          kind: "batty.label",
          data: { targetId, label: label ?? null },
        }),
      context,
    );
    await this.refresh();
    this.publishSummary();
  }
  async configuration(): Promise<SessionConfiguration> {
    const agent = this.agentState;
    const preference = this.records.findLast(
      (record) =>
        record.kind === "batty.custom" &&
        (record.data as { customType?: string })?.customType === SESSION_TOOLS_CUSTOM_TYPE,
    );
    const tools = preference?.data as { data: SessionTools } | undefined;
    return {
      model: agent?.model,
      thinkingLevel: agent?.thinkingLevel,
      activeToolNames: tools?.data.activeToolNames,
    };
  }
  async configure(configuration: SessionConfiguration): Promise<void> {
    await this.conversation.commit(async (tx) => {
      const agent = await tx.doc(AgentDoc, this.conversation.id);
      if (configuration.model !== undefined) agent.model = configuration.model;
      if (configuration.thinkingLevel !== undefined)
        agent.thinkingLevel = configuration.thinkingLevel;
      if (configuration.activeToolNames !== undefined) {
        agent.tools = configuration.activeToolNames;
        await tx.appendEntry(this.conversation.id, {
          kind: "batty.custom",
          data: json({
            customType: SESSION_TOOLS_CUSTOM_TYPE,
            data: { activeToolNames: configuration.activeToolNames },
          }),
        });
      }
    }, context);
    await this.refresh();
    this.publishSummary();
  }
  async appendCustomEntry(customType: string, data: unknown): Promise<string> {
    const record = await this.conversation.commit(async (tx) => {
      return tx.appendEntry(this.conversation.id, {
        kind: "batty.custom",
        data: json({ customType, data }),
      });
    }, context);
    await this.refresh();
    this.publishSummary();
    return String(record.id);
  }
  async appendResultMessages(messages: AgentMessage[], replyId?: string): Promise<boolean> {
    const appended = await this.conversation.commit(async (tx) => {
      if (replyId) {
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanEntries({ conversationId: this.conversation.id }, 500, cursor);
          for (const record of page.items) {
            const data = record.data as
              | {
                  customType?: string;
                  details?: { battyResultReplyId?: string };
                  data?: { replyId?: string };
                }
              | undefined;
            if (
              record.kind === "batty.custom-message" &&
              data?.details?.battyResultReplyId === replyId
            )
              return false;
            if (
              record.kind === "batty.custom" &&
              data?.customType === "batty-result-delivery" &&
              data.data?.replyId === replyId
            )
              return false;
          }
          cursor = page.next;
        } while (cursor);
      }
      for (const message of messages)
        await tx.appendEntry(this.conversation.id, messageDraft(message));
      if (replyId)
        await tx.appendEntry(this.conversation.id, {
          kind: "batty.custom",
          data: json({ customType: "batty-result-delivery", data: { replyId } }),
        });
      return true;
    }, context);
    if (appended) {
      await this.refresh();
      this.publishSummary();
    }
    return appended;
  }
  async appendMessage(message: AgentMessage): Promise<string> {
    const record = await this.conversation.commit(
      (tx) => tx.appendEntry(this.conversation.id, messageDraft(message)),
      context,
    );
    await this.refresh();
    this.publishSummary();
    return String(record.id);
  }
  async fork(
    root: string,
    leafId: string | null = this.getLeafId(),
    id: string = randomUUID(),
  ): Promise<SessionStore> {
    await this.refresh();
    this.getBranch(leafId); // Validate the selected DTO identity.
    const cutoff = leafId === null ? undefined : Number(leafId.split(":")[0]);
    const records =
      cutoff === undefined ? [] : this.records.filter((record) => record.id <= cutoff);
    const agent =
      cutoff === undefined
        ? await this.harness.snapshot(AgentDoc, this.conversation.id, context)
        : await this.harness.snapshotAsOf(
            AgentDoc,
            this.conversation.id,
            cutoff as EntryId,
            context,
          );
    return SessionStore.createInitialized(
      this.getCwd(),
      root,
      this.file,
      id,
      async (tx, conversationId) => {
        Object.assign(await tx.doc(AgentDoc, conversationId), agent as AgentState);
        const mapped = new Map<EntryId, EntryId>();
        for (const record of records) {
          const requestId = [...this.submissions.values()].find(
            (submission) => submission.entry === record.id,
          )?.requestId;
          const {
            id: oldId,
            conversationId: _conversationId,
            byTaskId: _taskId,
            head,
            edits,
            ...draft
          } = record;
          const target = (entry: EntryId) => {
            const value = mapped.get(entry);
            if (!value) throw new Error(`Missing fork entry reference ${entry}`);
            return value;
          };
          const payload = record.data as Record<string, JsonValue> | undefined;
          const isToolResult = record.kind === "pi.tool-result";
          const isArtifact =
            record.kind === "batty.tool-artifacts" ||
            (record.kind === "batty.custom" && payload?.customType === "batty.tool-artifacts");
          const sourceTask = isToolResult
            ? (record.byTaskId ?? payload?.sourceToolTaskId)
            : undefined;
          const copy: EntryDraft = {
            ...draft,
            ...(requestId || sourceTask !== undefined || isArtifact
              ? {
                  data: json({
                    ...(record.data as object),
                    ...(requestId ? { submissionRequestId: requestId } : {}),
                    ...(sourceTask !== undefined ? { sourceToolTaskId: sourceTask } : {}),
                    ...(sourceTask !== undefined || isArtifact
                      ? { sourceTaskNamespace: payload?.sourceTaskNamespace ?? this.getSessionId() }
                      : {}),
                  }),
                }
              : {}),
            ...(head !== undefined ? { head: head === oldId ? "self" : target(head) } : {}),
            ...(edits
              ? { edits: edits.map((edit) => ({ ...edit, target: target(edit.target) })) }
              : {}),
          };
          // A UI cutoff inside a multi-message durable record retains just its selected prefix.
          if (oldId === cutoff && leafId !== null && this.getEntry(leafId)?.type === "message")
            (copy as { model: typeof record.model }).model = record.model?.slice(
              0,
              Number(leafId.split(":")[1] ?? 0) + 1,
            );
          if (record.kind === "batty.label") {
            const data = record.data as { targetId: string; label: string | null };
            (copy as { data: JsonValue }).data = {
              ...data,
              targetId: [
                String(target(Number(data.targetId.split(":")[0]) as EntryId)),
                ...data.targetId.split(":").slice(1),
              ].join(":"),
            };
          }
          mapped.set(oldId, (await tx.appendEntry(conversationId, copy)).id);
        }
      },
    );
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const owner = SessionStore.owners.get(this.file);
    if (owner) owner.retained = false;
    const closing = (async () => {
      try {
        if (owner?.leases)
          await new Promise<void>((resolve) => {
            owner.drained = resolve;
          });
        try {
          await this.refreshing;
        } finally {
          await this.harness.close(context);
        }
      } finally {
        this.unsubscribeCommits?.();
        try {
          await this.unlock();
        } finally {
          if (SessionStore.owners.get(this.file) === owner) SessionStore.owners.delete(this.file);
        }
      }
    })();
    this.closing = closing;
    if (owner) owner.closing = closing;
    return closing;
  }
  release(): Promise<void> {
    return this.close();
  }
}
function header(metadata: Metadata): SessionHeader {
  return {
    type: "session",
    version: 3,
    id: metadata.id,
    cwd: metadata.cwd,
    timestamp: metadata.timestamp,
    ...(metadata.parentSession ? { parentSession: metadata.parentSession } : {}),
    ...(metadata.name ? { name: metadata.name } : {}),
  };
}
