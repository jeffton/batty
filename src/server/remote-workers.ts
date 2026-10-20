import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import type {
  SessionState,
  UiMessage,
  RunningSubagent,
  SessionMessagesPage,
} from "../shared/types";
import { RemoteAccess, type RemoteConnectionCredentials } from "./remote-access";
import type { Runtime } from "./runtime";
import type { WorkerCommand, WorkerCommandContext } from "./orchestration-workers";
import { stateDirPath } from "./options";
import { encodeRuntimeNotice } from "./runtime-notices";
import { reportWithArtifacts } from "./artifact-forwarding";
import type { AgentTurnArtifacts } from "./agent-turn-file-changes";
import { WorkerDoc } from "./orchestration-state";
import { storeSentFiles } from "./send-files";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

export const remoteSessionId = (node: string, session: string) => `remote:${node}:${session}`;
export function parseRemoteSession(id: string) {
  const match = /^remote:([a-zA-Z0-9_-]+):(\d+)$/.exec(id);
  return match ? { node: match[1]!, session: match[2]! } : undefined;
}
export type RemoteWorkerSummary = {
  sessionId: string;
  workspaceId: string;
  status: string;
  startedAtMs?: number;
  terminalCursor?: string;
};
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

class NodeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function nodeRequest<T>(
  connection: RemoteConnectionCredentials,
  route: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(new URL(`api/node/${route}`, connection.url), {
    ...init,
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${connection.token}`,
      ...init.headers,
    },
  });
  if (!response.ok)
    throw new NodeHttpError(
      response.status,
      `Remote ${connection.id}: HTTP ${response.status}: ${await response.text()}`,
    );
  return (await response.json()) as T;
}

/** SSE framing shared by catalog and ordinary session projections, including chunk boundaries. */
export async function readNodeEvents(
  response: Response,
  receive: (value: Record<string, unknown>) => Promise<void>,
) {
  if (!response.ok) throw new Error(`Remote event stream HTTP ${response.status}`);
  if (!response.body) throw new Error("Remote event stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "{}") await receive(JSON.parse(data) as Record<string, unknown>);
      }
    }
  } finally {
    await reader.cancel();
  }
}

export class RemoteWorkers {
  readonly changes = new EventEmitter();
  readonly access: RemoteAccess;
  private readonly mirrors = new Map<string, Mirror>();
  private index: LocalIndex = { assignments: [], origins: {} };
  private writes: Promise<void> = Promise.resolve();
  private readonly running = new Map<string, AbortController>();
  private readonly importedFiles = new Map<string, Promise<unknown>>();
  private readonly loops = new Set<Promise<void>>();
  private stopped = false;
  private constructor(
    private readonly runtime: Runtime,
    access: RemoteAccess,
    private readonly directory: string,
  ) {
    this.access = access;
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
    for (const connection of this.access.listConnections()) this.connect(connection.id);
  }
  connect(node: string) {
    if (this.running.has(node) || this.stopped) return;
    const controller = new AbortController();
    this.running.set(node, controller);
    this.launch(
      this.reconnect(node, "catalog/events", controller.signal, async (event) => {
        const workers = event.workers as RemoteWorkerSummary[];
        if (!workers) return;
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
          if (worker.status === "running" || ((assigned || mirror.state) && !mirror.syncedTerminal))
            this.follow(mirror);
        }
        this.changes.emit("change");
      }),
    );
  }
  disconnect(node: string) {
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
        () =>
          `sessions/${mirror.session}/events${mirror.after ? `?after=${encodeURIComponent(mirror.after)}` : "?after=0"}`,
        controller.signal,
        async (event) => {
          if (event.type === "error") throw new Error(String(event.message));
          const activity = JSON.stringify([
            mirror.state?.isStreaming,
            mirror.state?.canStopSubagent,
          ]);
          if (event.type === "reset") {
            const state = (await this.importValue(mirror.node, event.state)) as SessionState;
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
            mirror.state = {
              ...mirror.state,
              ...((await this.importValue(mirror.node, event.state)) as Partial<SessionState>),
            };
          } else if (event.type === "assistant" && mirror.state) {
            mirror.state.activeAssistant = (await this.importValue(
              mirror.node,
              event.assistant,
            )) as SessionState["activeAssistant"];
          } else if (event.type === "tools" && mirror.state) {
            mirror.state.activeTools = (await this.importValue(
              mirror.node,
              event.tools,
            )) as SessionState["activeTools"];
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
          this.changes.emit("change");
          if (terminal) controller.abort();
        },
        mirror,
      ).finally(() => {
        if (this.running.get(key) === controller) this.running.delete(key);
      }),
    );
  }
  private launch(loop: Promise<void>) {
    this.loops.add(loop);
    void loop
      .catch((error) => console.error("Remote stream stopped", error))
      .finally(() => this.loops.delete(loop));
  }
  private async reconnect(
    node: string,
    route: string | (() => string),
    signal: AbortSignal,
    receive: (value: Record<string, unknown>) => Promise<void>,
    mirror?: Mirror,
  ) {
    while (!signal.aborted && !this.stopped) {
      try {
        const connection = this.connection(node);
        const response = await fetch(
          new URL(`api/node/${typeof route === "function" ? route() : route}`, connection.url),
          {
            redirect: "error",
            signal,
            headers: { authorization: `Bearer ${connection.token}` },
          },
        );
        await readNodeEvents(response, receive);
        if (!signal.aborted) throw new Error(`Remote ${node} event stream disconnected`);
      } catch (error) {
        if (signal.aborted) break;
        if (mirror) {
          mirror.error = String(error);
          await this.persistMirror(mirror);
        }
        console.error(`Remote ${node} stream`, error);
        this.changes.emit("change");
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 1000);
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
    if (!connection) throw new Error(`Unknown remote instance: ${node}`);
    return connection;
  }
  async stop(id: string) {
    const parsed = parseRemoteSession(id);
    if (!parsed) throw new Error("Invalid remote session ID");
    const result = await nodeRequest<{ isError?: boolean; output?: unknown }>(
      this.connection(parsed.node),
      "commands",
      {
        method: "POST",
        body: JSON.stringify({
          requestId: `stop:${randomUUID()}`,
          command: { action: "stop", sessionId: parsed.session },
        }),
      },
    );
    if (result.isError) throw new Error(JSON.stringify(result.output));
  }
  async workspaces(node?: string) {
    return Promise.all(
      (node
        ? [this.connection(node)]
        : this.access.listConnections().map((item) => this.connection(item.id))
      ).map(async (connection) => ({
        nodeId: connection.id,
        label: connection.label,
        ...(await nodeRequest<{ workspaces: unknown[] }>(connection, "workspaces")),
      })),
    );
  }
  list() {
    return [...this.mirrors.values()]
      .filter((mirror) => this.access.getConnection(mirror.node))
      .map((mirror) => ({
        ...mirror.summary,
        sessionId: remoteSessionId(mirror.node, mirror.session),
        nodeId: mirror.node,
        ...(mirror.error ? { error: mirror.error } : {}),
      }));
  }
  tasks(parentId: number): RunningSubagent[] {
    return [...this.mirrors.values()]
      .filter(
        (mirror) =>
          this.access.getConnection(mirror.node) &&
          mirror.summary.status === "running" &&
          (parentId === this.runtime.main.id ||
            this.index.assignments.some(
              (item) =>
                item.node === mirror.node &&
                item.session === mirror.session &&
                item.parentId === parentId,
            )),
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
      remote: { nodeId: mirror.node, ...(mirror.error ? { error: mirror.error } : {}) },
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
    if (args.includePreviousContext)
      throw new Error("Remote workers use their own context; omit includePreviousContext");
    const requestId = `tool:${api.conversationId}:${api.taskId}`;
    const { nodeId: _nodeId, ...command } = args;
    if (parsed) command.sessionId = parsed.session;
    if (["run", "queue", "resume"].includes(command.action)) {
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
    const result = await nodeRequest<{
      output?: JsonValue;
      details?: JsonValue;
      isError?: boolean;
    }>(this.connection(node), "commands", {
      method: "POST",
      body: JSON.stringify({ requestId, command }),
    });
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
        workers?: RemoteWorkerSummary[];
        latest?: { text: string };
      };
      if (decoded.sessionId) decoded.sessionId = remoteSessionId(node, decoded.sessionId);
      if (decoded.workers)
        decoded.workers = decoded.workers.map((worker) => ({
          ...worker,
          sessionId: remoteSessionId(node, worker.sessionId),
        }));
      if (decoded.latest)
        decoded.latest.text = reportWithArtifacts(
          decoded.latest.text.split(
            "\n\nExisting response artifacts available for explicit forwarding:",
          )[0]!,
          (await this.importValue(node, result.details ?? {})) as AgentTurnArtifacts,
        );
      output = JSON.stringify(decoded);
    }
    if (args.action === "await") {
      const assignmentId = (result.details as { assignmentId: string }).assignmentId;
      if (text.startsWith("Awaiting")) {
        const parent = await api.snapshot(WorkerDoc, api.conversationId, context);
        if (
          parent?.isSubagent &&
          !this.index.assignments.some(
            (item) =>
              item.node === node &&
              item.session === session &&
              item.parentId === api.conversationId,
          )
        )
          throw new Error("Await requires a remote child of this session");
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
            text: reportWithArtifacts(finished.text ?? finished.status, finished.artifacts),
          },
        ],
        details: finished.artifacts as JsonValue,
      };
    }
    return {
      output: [{ type: "text" as const, text: output }],
      ...(result.details
        ? { details: (await this.importValue(node, result.details)) as JsonValue }
        : {}),
    };
  }
  private async assignment(node: string, assignmentId: string, signal?: AbortSignal) {
    const result = await nodeRequest<{
      status: string;
      text?: string;
      artifacts?: AgentTurnArtifacts;
    }>(this.connection(node), `assignments/${assignmentId}`, { signal });
    return (await this.importValue(node, result)) as typeof result;
  }
  async join(
    input: { node: string; session: string; assignmentId: string; parentId: ConversationId },
    signal: AbortSignal,
  ) {
    for (;;) {
      signal.throwIfAborted();
      let result: { status: string; text?: string; artifacts?: AgentTurnArtifacts };
      try {
        result = await this.assignment(input.node, input.assignmentId, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof NodeHttpError && error.status < 500)
          result = { status: "failed", text: String(error) };
        else {
          console.error(`Remote ${input.node} await reconnect`, error);
          result = { status: "running" };
        }
      }
      if (result.status !== "running") {
        const parent = await this.runtime.harness.conversation(input.parentId, context);
        await parent!.submit(
          {
            type: "input",
            whenBusy: "steer",
            requestId: `remote-result:${input.node}:${input.assignmentId}:${input.parentId}`,
            content: encodeRuntimeNotice({
              kind: "subagent",
              text: `[subagent ${remoteSessionId(input.node, input.session)} result]\n${reportWithArtifacts(result.text ?? result.status, result.artifacts)}`,
              data: {
                subagent: { sessionId: remoteSessionId(input.node, input.session) },
                ...(result.artifacts ? { runtimeResultArtifacts: result.artifacts } : {}),
              },
            }),
          },
          context,
        );
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", done);
          resolve();
        }, 1000);
        signal.addEventListener("abort", done, { once: true });
      });
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
      artifacts?: AgentTurnArtifacts;
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
          text: `[subagent ${sessionId} ${message.customType === "batty.remote-report" ? "report" : "result"}]\n${reportWithArtifacts(data.text, data.artifacts)}`,
          data: {
            subagent: { sessionId },
            ...(data.artifacts ? { runtimeResultArtifacts: data.artifacts } : {}),
          },
        }),
      },
      context,
    );
  }
  private async importValue(node: string, value: unknown): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map((item) => this.importValue(node, item)));
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (
      typeof object.downloadUrl === "string" &&
      typeof object.name === "string" &&
      typeof object.id === "string"
    ) {
      const key = `${node}:${object.downloadUrl}`;
      let pending = this.importedFiles.get(key);
      if (!pending) {
        pending = this.importFile(node, object);
        this.importedFiles.set(key, pending);
      }
      try {
        return await pending;
      } catch (error) {
        this.importedFiles.delete(key);
        throw error;
      }
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(object)
          .filter(([key]) => key !== "sites" && key !== "storedPath")
          .map(async ([key, item]) => [key, await this.importValue(node, item)]),
      ),
    );
  }
  private async importFile(node: string, object: Record<string, unknown>) {
    const connection = this.connection(node);
    const source = new URL(String(object.downloadUrl), connection.url);
    const base = new URL(connection.url);
    if (source.origin !== base.origin) throw new Error("Remote file URL has a foreign origin");
    const match = /\/api\/sent-files\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(source.pathname);
    if (!match) throw new Error("Remote file does not use a sent-file manifest");
    const toolCallId = `remote-${node}-${match.slice(1).join("-")}`;
    const response = await fetch(
      new URL(`api/node/files/${match.slice(1).join("/")}`, connection.url),
      {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${connection.token}` },
      },
    );
    if (!response.ok) throw new Error(`Remote file HTTP ${response.status}`);
    const directory = path.join(this.directory, "downloads", toolCallId);
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, path.basename(String(object.name)));
    await fs.writeFile(temporary, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    const [file] = await storeSentFiles({
      rootDir: this.runtime.config.sentFilesDir,
      baseUrl: this.runtime.config.baseUrl,
      workspaceId: `remote-${node}`,
      sessionId: match[2]!,
      toolCallId,
      cwd: directory,
      paths: [temporary],
      reuseExisting: true,
    });
    return file;
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
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    await Promise.allSettled(this.loops);
    await this.writes;
  }
}
