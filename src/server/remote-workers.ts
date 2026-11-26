import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { snapshotWorkerFiles, workerFileMetadata } from "./worker-files";
import { RpcError, type RpcContext, type RpcReply } from "../shared/rpc";
import { createNodeRpcHandler, workerBody } from "./node-rpc";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { ConversationId } from "@earendil-works/pi-durable";
import type {
  SessionState,
  UiMessage,
  RunningSubagent,
  SessionMessagesPage,
  SentFileDescriptor,
} from "../shared/types";
import { RemoteAccess, type RemoteConnectionCredentials } from "./remote-access";
import { ReverseConnections } from "./reverse-connections";
import type {
  NodeInputs,
  NodeOutputs,
  NodeEvent,
  NodeOperation,
  NodeWorkerSummary,
  NodePresentation,
  NodeMessage,
} from "../shared/node-api";
import type { Runtime } from "./runtime";
import type { WorkerCommand, WorkerCommandContext } from "./orchestration-workers";
import { stateDirPath } from "./options";
import { encodeRuntimeNotice } from "./runtime-notices";
import { ArtifactResolver } from "./artifact-resolver";
import { describePresentation } from "./message-presentation";
import { nodeSessionEvent } from "./remote-presentation";
import { OrchestrationDoc, WorkerDoc } from "./orchestration-state";
import { storeSentFiles } from "./send-files";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

export const remoteSessionId = (node: string, session: string) => `remote:${node}:${session}`;
export function parseRemoteSession(id: string) {
  const match = /^remote:([a-zA-Z0-9_-]+):(\d+)$/.exec(id);
  return match ? { node: match[1]!, session: match[2]! } : undefined;
}
export type RemoteWorkerSummary = NodeWorkerSummary;

function qualifiedWorker(node: string, worker: RemoteWorkerSummary) {
  return {
    ...worker,
    sessionId: remoteSessionId(node, worker.sessionId),
    ...(worker.parentId ? { parentId: remoteSessionId(node, worker.parentId) } : {}),
    nodeId: node,
  };
}
type Mirror = {
  node: string;
  session: string;
  summary: RemoteWorkerSummary;
  state?: SessionState;
  after?: string;
  messages: UiMessage[];
  error?: string;
  syncedTerminal?: boolean;
};
type Assignment = {
  node: string;
  requestId: string;
  parentId: number;
  prompt?: string;
  session?: string;
  grantId?: string;
};
type LocalIndex = { assignments: Assignment[]; origins: Record<string, string> };
type NodeDiscovery = NodeOutputs["node.discovery"] & { nodeId: string; label: string };
type NodeDiscoveryError = { nodeId: string; label: string; error: string };

class PermanentFileImportError extends Error {}

export type NodeCallOptions = { signal?: AbortSignal; body?: ReadableStream<Uint8Array> };

/** A bounded call handshake; returned streams retain caller cancellation, not a timer. */
export async function withNodeDeadline<T, Event>(
  options: NodeCallOptions,
  call: (signal: AbortSignal) => Promise<RpcReply<T, Event>>,
): Promise<RpcReply<T, Event>> {
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new RpcError("OFFLINE", "Remote call timed out")),
    options.body ? 300_000 : 30_000,
  );
  try {
    return await call(
      options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal,
    );
  } finally {
    clearTimeout(timer);
  }
}

export class RemoteWorkers {
  readonly changes = new EventEmitter();
  readonly access: RemoteAccess;
  readonly reverse: ReverseConnections;

  /** Native calls retain domain errors, JSON items and byte streams without HTTP envelopes. */
  readonly requestNode = async <K extends NodeOperation>(
    connection: RemoteConnectionCredentials,
    operation: K,
    input: NodeInputs[K],
    options: NodeCallOptions = {},
  ): Promise<RpcReply<NodeOutputs[K], NodeEvent<K>>> => {
    return withNodeDeadline(options, (signal) =>
      this.reverse
        .channel(connection)
        .call<NodeOutputs[K], NodeEvent<K>>(operation, input, { ...options, signal }),
    );
  };

  handleNode(
    connection: RemoteConnectionCredentials,
    operation: string,
    input: unknown,
    call: RpcContext,
  ) {
    return createNodeRpcHandler(this, connection)(operation, input, call);
  }

  private async nodeRequest<K extends NodeOperation>(
    connection: RemoteConnectionCredentials,
    operation: K,
    input: NodeInputs[K],
    options: NodeCallOptions = {},
  ) {
    return (await this.requestNode(connection, operation, input, options)).value;
  }
  private readonly mirrors = new Map<string, Mirror>();
  private index: LocalIndex = { assignments: [], origins: {} };
  private writes: Promise<void> = Promise.resolve();
  private readonly running = new Map<string, AbortController>();
  private readonly importedFiles = new Map<string, Promise<SentFileDescriptor>>();
  private readonly loops = new Set<Promise<void>>();
  private stopped = false;
  private constructor(
    readonly runtime: Runtime,
    access: RemoteAccess,
    private readonly directory: string,
  ) {
    this.access = access;
    this.reverse = new ReverseConnections(this);
  }

  static async open(runtime: Runtime) {
    const directory = path.join(stateDirPath(runtime.config.battyDir), "remote-mirrors");
    await fs.mkdir(directory, { recursive: true });
    const remotes = new RemoteWorkers(
      runtime,
      await RemoteAccess.open(runtime.config.battyDir),
      directory,
    );
    for (const name of await fs.readdir(directory)) {
      if (!name.endsWith(".json")) continue;
      const value = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
      if (name === "assignments.json") remotes.index = value as LocalIndex;
      else {
        const mirror = value as Mirror;
        if (!mirror.syncedTerminal) mirror.error = "Remote connection has not been re-established";
        remotes.mirrors.set(remoteSessionId(mirror.node, mirror.session), mirror);
      }
    }
    return remotes;
  }
  start() {
    // Catalog subscriptions start only after the socket verifies peer identity.
    this.reverse.reconfigure();
  }
  connect(node: string) {
    if (this.running.has(node) || this.stopped) return;
    const controller = new AbortController();
    this.running.set(node, controller);
    this.launch(
      this.reconnect(
        node,
        "node.catalog.watch",
        () => ({}),
        controller.signal,
        async (event) => {
          const workers = event.workers;
          if (!workers) return;
          this.changes.emit("catalog", node);
          for (const worker of workers) {
            const id = remoteSessionId(node, worker.sessionId);
            const mirror = this.mirrors.get(id) ?? {
              node,
              session: worker.sessionId,
              summary: worker,
              messages: [],
            };
            const changed =
              !this.mirrors.has(id) || JSON.stringify(mirror.summary) !== JSON.stringify(worker);
            mirror.summary = worker;
            if (worker.status === "running") mirror.syncedTerminal = false;
            this.mirrors.set(id, mirror);
            if (this.terminalMirrored(mirror)) {
              mirror.syncedTerminal = true;
              this.running.get(`${node}:${worker.sessionId}`)?.abort();
            }
            if (changed) await this.persistMirror(mirror);
            const assigned = this.index.assignments.some(
              (item) => item.node === node && item.session === worker.sessionId,
            );
            if (
              worker.status === "running" ||
              ((assigned || mirror.state) && !mirror.syncedTerminal)
            )
              this.follow(mirror);
          }
          this.changes.emit("change");
          this.changes.emit("tasks");
        },
      ).finally(() => {
        if (this.running.get(node) === controller) this.running.delete(node);
      }),
    );
  }
  disconnect(node: string) {
    // Wake pending joins after the owner removes a configured peer.
    queueMicrotask(() => {
      this.changes.emit("catalog", node);
      this.changes.emit("change");
      this.changes.emit("tasks");
    });
    for (const [key, controller] of this.running)
      if (key === node || key.startsWith(`${node}:`)) {
        controller.abort();
        this.running.delete(key);
      }
  }
  private terminalMirrored(mirror: Mirror) {
    return (
      mirror.summary.status !== "running" &&
      mirror.summary.terminalCursor !== undefined &&
      mirror.after !== undefined &&
      Number(mirror.after) >= Number(mirror.summary.terminalCursor)
    );
  }
  private follow(mirror: Mirror) {
    const key = `${mirror.node}:${mirror.session}`;
    if ((this.running.has(key) && !this.running.get(key)!.signal.aborted) || this.stopped) return;
    const controller = new AbortController();
    this.running.set(key, controller);
    this.launch(
      this.reconnect(
        mirror.node,
        "node.session.watch",
        () => ({ sessionId: mirror.session, after: mirror.after ?? "0" }),
        controller.signal,
        async (wireEvent) => {
          const event = nodeSessionEvent(wireEvent, true);
          if (!event) return;
          if (event.type === "error") throw new Error(String(event.message));
          const taskSignature = this.taskSignature(mirror);
          const activity = JSON.stringify([
            mirror.state?.isStreaming,
            mirror.state?.canStopSubagent,
          ]);
          if (event.type === "reset") {
            const state = {
              ...event.state,
              messages: await Promise.all(
                event.state.messages.map((message) => this.importMessage(mirror.node, message)),
              ),
            };
            controller.signal.throwIfAborted();
            const messages = new Map(mirror.messages.map((message) => [message.id, message]));
            for (const message of state.messages) messages.set(message.id, message);
            mirror.messages = [...messages.values()].sort(
              (a, b) => Number(a.id.split(":")[0]) - Number(b.id.split(":")[0]),
            );
            mirror.state = { ...state, messages: [] };
            // Deliver before advancing the durable cursor. Remote request IDs deduplicate after a local crash.
            for (const message of state.messages) await this.deliver(mirror, message);
            controller.signal.throwIfAborted();
            mirror.after = String(Math.max(Number(mirror.after ?? 0), Number(state.historyCursor)));
          } else if (event.type === "state" && mirror.state) {
            mirror.state = { ...mirror.state, ...event.state };
          } else if (event.type === "assistant" && mirror.state) {
            mirror.state.activeAssistant = event.assistant;
          } else if (event.type === "tools" && mirror.state) {
            mirror.state.activeTools = event.tools;
          }
          delete mirror.error;
          const terminal = this.terminalMirrored(mirror);
          if (terminal) mirror.syncedTerminal = true;
          // Durable history/status is persisted; live token/tool projections remain volatile.
          if (
            event.type === "reset" ||
            terminal ||
            activity !== JSON.stringify([mirror.state?.isStreaming, mirror.state?.canStopSubagent])
          )
            await this.persistMirror(mirror);
          this.changes.emit("change", remoteSessionId(mirror.node, mirror.session));
          if (taskSignature !== this.taskSignature(mirror)) this.changes.emit("tasks");
          if (terminal) controller.abort();
        },
        mirror,
      ).finally(() => {
        if (this.running.get(key) === controller) this.running.delete(key);
      }),
    );
  }
  private taskSignature(mirror: Mirror) {
    return JSON.stringify([
      mirror.state?.model,
      mirror.state?.thinkingLevel,
      mirror.error,
      mirror.syncedTerminal,
    ]);
  }
  private launch(loop: Promise<void>) {
    this.loops.add(loop);
    void loop
      .catch((error) => console.error("Remote stream stopped", error))
      .finally(() => this.loops.delete(loop));
  }
  private async reconnect<K extends "node.catalog.watch" | "node.session.watch">(
    node: string,
    operation: K,
    input: () => NodeInputs[K],
    signal: AbortSignal,
    receive: (value: NodeEvent<K>) => Promise<void>,
    mirror?: Mirror,
  ) {
    let attempts = 0;
    while (!signal.aborted && !this.stopped) {
      const attempt = new AbortController();
      const refresh = (changedNode: string) => {
        if (changedNode === node) attempt.abort(new Error("Catalog resync requested"));
      };
      if (operation === "node.catalog.watch") this.changes.on("catalog-refresh", refresh);
      try {
        const connection = this.connection(node);
        const response = await this.requestNode(connection, operation, input(), {
          signal: AbortSignal.any([signal, attempt.signal]),
        });
        if (!response.events)
          throw new RpcError("INTERNAL", "Remote subscription has no event stream");
        const reader = response.events.getReader();
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            attempts = 0;
            await receive(item.value);
          }
        } finally {
          await reader.cancel();
        }
        if (!signal.aborted) throw new Error(`Remote ${node} event stream disconnected`);
      } catch (error) {
        if (signal.aborted) break;
        if (mirror) {
          mirror.error = String(error);
          await this.persistMirror(mirror);
        }
        console.error(`Remote ${node} stream`, error);
        this.changes.emit("change", mirror ? remoteSessionId(node, mirror.session) : undefined);
        this.changes.emit("tasks");
        if (error instanceof RpcError && ["UNAUTHORIZED", "FORBIDDEN"].includes(error.code)) {
          this.changes.emit("catalog", node);
          break;
        }
      } finally {
        if (operation === "node.catalog.watch") this.changes.off("catalog-refresh", refresh);
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(
          done,
          Math.min(30_000, 500 * 2 ** Math.min(attempts++, 6)) * (0.8 + Math.random() * 0.4),
        );
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
  async bindOrigin(node: string, instanceId: string) {
    await this.persist(async () => {
      const previous = this.index.origins[node];
      if (previous && previous !== instanceId)
        throw new Error("A remote ID with saved history cannot be reused for another installation");
      this.index.origins[node] = instanceId;
      await this.write("assignments.json", this.index);
    });
  }
  connection(node: string) {
    const connection = this.access.getConnection(node);
    if (!connection) throw new RpcError("NOT_FOUND", `Unknown remote instance: ${node}`);
    return connection;
  }
  async stop(id: string) {
    const parsed = parseRemoteSession(id);
    if (!parsed) throw new Error("Invalid remote session ID");
    const result = await this.nodeRequest(this.connection(parsed.node), "node.command", {
      requestId: `stop:${randomUUID()}`,
      command: { action: "stop", sessionId: parsed.session },
    });
    if (result.isError) throw new Error(JSON.stringify(result.output));
  }
  workspaces(node: string): Promise<NodeDiscovery[]>;
  workspaces(node?: string): Promise<Array<NodeDiscovery | NodeDiscoveryError>>;
  async workspaces(node?: string) {
    const discover = async (connection: RemoteConnectionCredentials) => ({
      nodeId: connection.id,
      label: connection.label,
      ...(await this.nodeRequest(connection, "node.discovery", {})),
    });
    if (node) return [await discover(this.connection(node))];
    const connections = this.access.listConnections().map((item) => this.connection(item.id));
    const results = await Promise.allSettled(connections.map(discover));
    return results.map((result, index) =>
      result.status === "fulfilled"
        ? result.value
        : {
            nodeId: connections[index]!.id,
            label: connections[index]!.label,
            error: String(result.reason),
          },
    );
  }
  list() {
    return [...this.mirrors.values()]
      .filter((mirror) => this.access.getConnection(mirror.node))
      .map((mirror) => ({
        ...qualifiedWorker(mirror.node, mirror.summary),
        connectionState:
          mirror.error && !mirror.syncedTerminal ? ("offline" as const) : ("online" as const),
        ...(mirror.error && !mirror.syncedTerminal ? { error: mirror.error } : {}),
      }));
  }
  tasks(parentId: number): RunningSubagent[] {
    return [...this.mirrors.values()]
      .filter(
        (mirror) =>
          this.access.getConnection(mirror.node) &&
          mirror.summary.status === "running" &&
          this.index.assignments.some(
            (item) =>
              item.node === mirror.node &&
              item.session === mirror.session &&
              item.parentId === parentId,
          ),
      )
      .map((mirror) => ({
        sessionId: remoteSessionId(mirror.node, mirror.session),
        conversationId: 0,
        workspaceId: `${mirror.node}/${mirror.summary.workspaceId}`,
        prompt:
          this.index.assignments.findLast(
            (item) => item.node === mirror.node && item.session === mirror.session,
          )?.prompt ?? "Remote subagent",
        sessionPath: `remote:${mirror.node}:${mirror.session}`,
        parentSessionId: String(parentId),
        model: mirror.state?.model ?? mirror.node,
        thinkingLevel: mirror.state?.thinkingLevel ?? "off",
        startedAtMs: mirror.summary.startedAtMs ?? null,
        remote: {
          nodeId: mirror.node,
          connectionState:
            mirror.error && !mirror.syncedTerminal ? ("offline" as const) : ("online" as const),
          status: mirror.summary.status,
          ...(mirror.error && !mirror.syncedTerminal ? { error: mirror.error } : {}),
        },
      }));
  }
  state(id: string, includeHistory = true, after?: string): SessionState {
    const mirror = this.mirrors.get(id);
    if (!mirror?.state)
      throw Object.assign(new Error("Remote session has not been mirrored yet"), {
        statusCode: 404,
      });
    const candidates =
      after === undefined
        ? mirror.messages
        : mirror.messages.filter((message) => Number(message.id.split(":")[0]) > Number(after));
    const messages = !includeHistory
      ? []
      : after === undefined
        ? candidates.slice(-120)
        : candidates.slice(0, 120);
    const moreRecent = includeHistory && after !== undefined && candidates.length > messages.length;
    const cursor = moreRecent ? messages.at(-1)!.id.split(":")[0] : mirror.after;
    return {
      ...mirror.state,
      streamId: this.runtime.streamId,
      revision: this.runtime.nextRevision(),
      id,
      sessionId: id,
      path: id,
      workspaceId: `${mirror.node}/${mirror.summary.workspaceId}`,
      title: `Subagent · ${mirror.node}`,
      remote: {
        nodeId: mirror.node,
        connectionState: mirror.error && !mirror.syncedTerminal ? "offline" : "online",
        status: mirror.summary.status,
        ...(mirror.error && !mirror.syncedTerminal ? { error: mirror.error } : {}),
      },
      messages,
      totalMessageCount: mirror.messages.length,
      hasMoreMessages: mirror.messages.length > messages.length,
      hasMoreRecentMessages: moreRecent,
      historyAfter: after,
      historyCursor: includeHistory ? cursor : undefined,
      canStopSubagent: !mirror.error && !mirror.syncedTerminal && mirror.state.canStopSubagent,
      ...(mirror.syncedTerminal
        ? {
            isStreaming: false,
            isCompacting: false,
            activeAssistant: undefined,
            activeTools: [],
            pendingMessageCount: 0,
            queuedPrompts: [],
          }
        : {}),
    };
  }
  messages(id: string, before?: string, limit = 120): SessionMessagesPage {
    this.state(id);
    const all = this.mirrors.get(id)!.messages;
    const candidates = all.filter(
      (item) =>
        before === undefined || Number(item.id.split(":")[0]) < Number(before.split(":")[0]),
    );
    const messages = candidates.slice(-limit);
    return {
      messages,
      totalMessageCount: all.length,
      hasMoreMessages: candidates.length > messages.length,
    };
  }
  async command(
    args: WorkerCommand & { nodeId?: string },
    api: WorkerCommandContext,
    _ctx: Context,
  ) {
    const parsed = args.sessionId ? parseRemoteSession(args.sessionId) : undefined;
    const node = args.nodeId ?? parsed?.node;
    if (!node || (parsed && args.nodeId && parsed.node !== args.nodeId))
      throw new Error("Remote command requires a matching nodeId/sessionId");
    if (args.action === "inspect" && args.sessionId) {
      const mirror = this.mirrors.get(remoteSessionId(node, parsed?.session ?? args.sessionId));
      if (mirror?.error && !mirror.syncedTerminal) {
        this.connection(node);
        return {
          output: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ...qualifiedWorker(node, mirror.summary),
                connectionState: "offline",
                error: mirror.error,
              }),
            },
          ],
        };
      }
    }
    const requestId = `tool:${api.conversationId}:${api.taskId}`;
    const files = args.files
      ? await snapshotWorkerFiles(
          { rootDir: this.runtime.config.sentFilesDir, baseUrl: this.runtime.config.baseUrl },
          args.files,
          api,
          _ctx,
          (ref) => new ArtifactResolver(this.runtime.config).resolveFileSource(ref),
        )
      : [];
    const {
      nodeId: _nodeId,
      files: _files,
      artifactRefs: _refs,
      browserId: _browser,
      ...command
    } = args;
    if (parsed) command.sessionId = parsed.session;
    const { action, ...workerInput } = command;
    if (action === "report" || action === "workspaces")
      throw new RpcError("BAD_INPUT", "Invalid node worker action or requestId");
    if (["run", "queue", "resume"].includes(action)) {
      await this.persist(async () => {
        if (
          !this.index.assignments.some((item) => item.node === node && item.requestId === requestId)
        )
          this.index.assignments.push({
            node,
            requestId,
            parentId: api.conversationId,
            prompt: args.prompt,
            grantId: this.connection(node).grantId,
          });
        await this.write("assignments.json", this.index);
      });
    }
    if (action === "await") {
      const state = await api.snapshot(OrchestrationDoc, context);
      if (
        api.conversationId !== state?.mainId &&
        !this.index.assignments.some(
          (item) =>
            item.node === node &&
            item.session === parsed?.session &&
            item.parentId === api.conversationId,
        )
      )
        throw new Error("Await requires a remote child of this session");
    }
    const result = await this.nodeRequest(
      this.connection(node),
      "node.command",
      {
        requestId,
        command: { ...workerInput, action },
        ...(files.length ? { files: workerFileMetadata(files) } : {}),
      },
      files.length ? { body: workerBody(files), signal: AbortSignal.timeout(300_000) } : {},
    );
    const text = Array.isArray(result.output)
      ? result.output
          .map((part) => (typeof part === "object" && part && "text" in part ? part.text : ""))
          .join("\n")
      : String(result.output ?? "");
    if (result.isError) throw new Error(text);
    const session = /Session ID: (\d+)/.exec(text)?.[1];
    if (session) {
      const assignment = this.index.assignments.find(
        (item) => item.node === node && item.requestId === requestId,
      );
      if (assignment) {
        assignment.session = session;
        await this.persist(() => this.write("assignments.json", this.index));
      }
      const id = remoteSessionId(node, session);
      const mirror = this.mirrors.get(id) ?? {
        node,
        session,
        summary: { sessionId: session, workspaceId: args.workspaceId ?? "", status: "running" },
        messages: [],
      };
      this.mirrors.set(id, mirror);
      this.follow(mirror);
      await api.details({ subagent: { sessionId: id }, conversationId: id }, context);
    }
    let output = text.replace(
      /Session ID: (\d+)/g,
      (_, id: string) => `Session ID: ${remoteSessionId(node, id)}`,
    );
    if (args.action === "list" || args.action === "inspect") {
      const decoded = JSON.parse(text) as {
        sessionId?: string;
        parentId?: string;
        nodeId?: string;
        workers?: RemoteWorkerSummary[];
        latest?: { text: string };
      };
      if (decoded.sessionId) {
        decoded.sessionId = remoteSessionId(node, decoded.sessionId);
        decoded.nodeId = node;
      }
      if (decoded.parentId) decoded.parentId = remoteSessionId(node, decoded.parentId);
      if (decoded.workers)
        decoded.workers = decoded.workers.map((worker) => qualifiedWorker(node, worker));
      if (args.action === "inspect") {
        const presentation = decoded.latest
          ? await this.importPresentation(node, result.presentation)
          : undefined;
        if (decoded.latest)
          decoded.latest.text = describePresentation(decoded.latest.text, presentation);
        return {
          output: [{ type: "text" as const, text: JSON.stringify(decoded) }],
          ...(presentation ? { details: { presentation } as unknown as JsonValue } : {}),
        };
      }
      output = JSON.stringify(decoded);
    }
    if (args.action === "await") {
      const assignmentId = result.details!.assignmentId;
      if (text.startsWith("Awaiting")) {
        await api.commit(async (tx) => {
          const metadata = await tx.doc(WorkerDoc, api.conversationId);
          const key = `remote:${node}:${assignmentId}`;
          if (metadata.completion?.waits[key] !== undefined) return;
          const waiter = await tx.createTask(
            this.runtime.orchestration.remoteJoinTask,
            { node, session: session!, assignmentId, parentId: api.conversationId },
            {
              ownership: metadata.completion
                ? { kind: "task", taskId: metadata.completion.owner }
                : { kind: "conversation" },
              background: !metadata.completion,
            },
          );
          if (metadata.completion) metadata.completion.waits[key] = waiter;
        }, context);
        return {
          output: [{ type: "text" as const, text: output }],
          control: { terminate: true as const },
        };
      }
      const finished = await this.assignment(node, assignmentId);
      return {
        output: [
          {
            type: "text" as const,
            text: describePresentation(finished.text ?? finished.status, finished.presentation),
          },
        ],
        ...(finished.presentation
          ? { details: { presentation: finished.presentation } as unknown as JsonValue }
          : {}),
      };
    }
    return { output: [{ type: "text" as const, text: output }] };
  }
  private async assignment(node: string, assignmentId: string, signal?: AbortSignal) {
    const result = await this.nodeRequest(
      this.connection(node),
      "node.assignment",
      { assignmentId },
      { signal },
    );
    return { ...result, presentation: await this.importPresentation(node, result.presentation) };
  }
  async join(
    input: { node: string; session: string; assignmentId: string; parentId: ConversationId },
    signal: AbortSignal,
  ) {
    // Subscribe before checking status so a completion during the fetch cannot be missed.
    // Catalog snapshots also arrive after reconnect, including unchanged worker summaries.
    let dirty = true;
    let wake: (() => void) | undefined;
    const changed = (node: string) => {
      if (node !== input.node) return;
      dirty = true;
      wake?.();
    };
    const aborted = () => wake?.();
    this.changes.on("catalog", changed);
    signal.addEventListener("abort", aborted);
    try {
      for (;;) {
        signal.throwIfAborted();
        dirty = false;
        let result: NodeOutputs["node.assignment"];
        try {
          result = await this.assignment(input.node, input.assignmentId, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (
            error instanceof RpcError &&
            ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "BAD_INPUT"].includes(error.code)
          )
            result = { status: "failed", text: String(error) };
          else {
            console.error(`Remote ${input.node} await reconnect`, error);
            // The triggering snapshot may be the last commit. Reconnect the catalog
            // for a fresh snapshot rather than waiting forever or polling status.
            this.changes.emit("catalog-refresh", input.node);
            result = { status: "running" };
          }
        }
        signal.throwIfAborted();
        if (result.status !== "running") {
          const parent = await this.runtime.harness.conversation(input.parentId, context);
          await parent!.submit(
            {
              type: "input",
              whenBusy: "steer",
              requestId: `remote-result:${input.node}:${input.assignmentId}:${input.parentId}`,
              content: encodeRuntimeNotice({
                kind: "subagent",
                text: `[subagent ${remoteSessionId(input.node, input.session)} result]\n${describePresentation(result.text ?? result.status, result.presentation)}`,
                data: {
                  subagent: { sessionId: remoteSessionId(input.node, input.session) },
                  ...(result.presentation ? { runtimePresentation: result.presentation } : {}),
                },
              }),
            },
            context,
          );
          return;
        }
        signal.throwIfAborted();
        if (!dirty) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      }
    } finally {
      this.changes.off("catalog", changed);
      signal.removeEventListener("abort", aborted);
    }
  }
  private async deliver(mirror: Mirror, message: UiMessage) {
    if (
      message.role !== "custom" ||
      !["batty.remote-report", "batty.remote-result"].includes(message.customType)
    )
      return;
    const data = message.data as {
      assignment: { requestId: string; grantId: string };
      assignmentId: string;
      text: string;
      presentation?: NodePresentation;
    };
    const assignment = this.index.assignments.find(
      (item) =>
        item.node === mirror.node &&
        item.requestId === data.assignment.requestId &&
        item.grantId === data.assignment.grantId,
    );
    if (!assignment) return;
    const parent = await this.runtime.harness.conversation(
      assignment.parentId as ConversationId,
      context,
    );
    if (!parent) throw new Error("Remote assignment parent is missing");
    const sessionId = remoteSessionId(mirror.node, mirror.session);
    await parent.submit(
      {
        type: "input",
        whenBusy: "steer",
        requestId:
          message.customType === "batty.remote-result"
            ? `remote-result:${mirror.node}:${data.assignmentId}:${assignment.parentId}`
            : `remote:${mirror.node}:${mirror.session}:${message.id}`,
        content: encodeRuntimeNotice({
          kind: "subagent",
          text: `[subagent ${sessionId} ${message.customType === "batty.remote-report" ? "report" : "result"}]\n${describePresentation(data.text, data.presentation)}`,
          data: {
            subagent: { sessionId },
            ...(data.presentation ? { runtimePresentation: data.presentation } : {}),
          },
        }),
      },
      context,
    );
  }
  private async importMessage(node: string, message: NodeMessage): Promise<UiMessage> {
    if (message.role === "assistant") {
      const { presentation, ...assistant } = message;
      const imported = await this.importPresentation(node, presentation);
      return {
        ...assistant,
        sentFiles: imported?.sentFiles,
        blocks: imported?.importErrors?.length
          ? [
              ...assistant.blocks,
              {
                type: "text",
                text: describePresentation("", { importErrors: imported.importErrors }).trim(),
              },
            ]
          : assistant.blocks,
      };
    }
    if (message.role !== "custom" || !message.data) return message;
    const key = message.customType.startsWith("batty-runtime-notice:")
      ? "runtimePresentation"
      : "presentation";
    const { inputFiles, ...data } = message.data;
    const presentation = await this.importPresentation(
      node,
      data[key] as NodePresentation | undefined,
    );
    const inputs = Array.isArray(inputFiles)
      ? await this.importPresentation(node, { sentFiles: inputFiles })
      : undefined;
    return {
      ...message,
      data: {
        ...data,
        [key]: presentation,
        ...(inputs?.sentFiles ? { inputFiles: inputs.sentFiles } : {}),
        ...(inputs?.importErrors ? { inputFileImportErrors: inputs.importErrors } : {}),
      },
    };
  }

  private async importPresentation(
    node: string,
    presentation?: NodePresentation,
  ): Promise<NodePresentation | undefined> {
    if (!presentation) return undefined;
    const imports = await Promise.all(
      (presentation.sentFiles ?? []).map((file) => this.importSelectedFile(node, file)),
    );
    const sentFiles = imports.flatMap((result) => (result.file ? [result.file] : []));
    const importErrors = [
      ...new Set([
        ...(presentation.importErrors ?? []),
        ...imports.flatMap((result) => (result.error ? [result.error] : [])),
      ]),
    ];
    return {
      ...(sentFiles.length ? { sentFiles } : {}),
      ...(importErrors.length ? { importErrors } : {}),
    };
  }

  private async importSelectedFile(node: string, file: SentFileDescriptor) {
    const key = `${node}:${file.downloadUrl}`;
    let pending = this.importedFiles.get(key);
    if (!pending) {
      pending = this.importFile(node, file);
      this.importedFiles.set(key, pending);
    }
    try {
      return { file: await pending };
    } catch (error) {
      if (!(error instanceof PermanentFileImportError) && this.importedFiles.get(key) === pending)
        this.importedFiles.delete(key);
      return { error: `${file.name}: ${String(error)}` };
    }
  }

  private async importFile(node: string, file: SentFileDescriptor) {
    const connection = this.connection(node);
    // Reverse peers have no network address. Their manifests contain app-relative paths;
    // the URL only parses the manifest, while bytes travel over the authenticated node route.
    const base = new URL(
      connection.transport === "reverse" ? "http://batty.invalid/" : connection.url!,
    );
    if (!URL.canParse(file.downloadUrl, base))
      throw new PermanentFileImportError("Remote file URL is invalid");
    const source = new URL(file.downloadUrl, base);
    if (source.origin !== base.origin)
      throw new PermanentFileImportError("Remote file URL has a foreign origin");
    const match = /\/api\/sent-files\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(source.pathname);
    if (!match) throw new PermanentFileImportError("Remote file does not use a sent-file manifest");
    const toolCallId = `remote-${node}-${match.slice(1).join("-")}`;
    let response: RpcReply<NodeOutputs["node.file"], never>;
    try {
      response = await this.requestNode(
        connection,
        "node.file",
        {
          workspaceId: decodeURIComponent(match[1]!),
          sessionId: decodeURIComponent(match[2]!),
          toolCallId: decodeURIComponent(match[3]!),
          fileId: decodeURIComponent(match[4]!),
        },
        { signal: AbortSignal.timeout(30_000) },
      );
    } catch (error) {
      const message = `Remote file ${error instanceof RpcError ? error.code : String(error)}`;
      if (
        error instanceof RpcError &&
        ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN", "BAD_INPUT"].includes(error.code)
      )
        throw new PermanentFileImportError(message);
      throw new Error(message);
    }
    if (!response.body) throw new Error("Remote file has no byte stream");
    const directory = await fs.mkdtemp(path.join(this.directory, "download-"));
    try {
      const temporary = path.join(directory, "attachment");
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(temporary, { mode: 0o600 }),
      );
      const [imported] = await storeSentFiles({
        rootDir: this.runtime.config.sentFilesDir,
        baseUrl: this.runtime.config.baseUrl,
        workspaceId: `remote-${node}`,
        sessionId: match[2]!,
        toolCallId,
        cwd: directory,
        paths: [temporary],
        names: [response.value.name],
        reuseExisting: true,
      });
      return imported!;
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  private persistMirror(mirror: Mirror) {
    return this.persist(() => this.write(`${mirror.node}-${mirror.session}.json`, mirror));
  }
  private persist(change: () => Promise<void>) {
    const pending = this.writes.then(change);
    this.writes = pending.catch(() => {});
    return pending;
  }
  private async write(name: string, value: unknown) {
    const target = path.join(this.directory, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temporary, target);
  }
  async close() {
    this.stopped = true;
    await this.reverse.close();
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    await Promise.allSettled(this.loops);
    await this.writes;
  }
}
