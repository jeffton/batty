import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { TaskId } from "@earendil-works/pi-durable";
import { RpcError, rpcRegistry, type RpcHandler, type RpcReply } from "../shared/rpc";
import type { NodeInputs, NodeOutputs, NodeEvents } from "../shared/node-api";
export type { NodeCommandInput } from "../shared/node-api";
import type { RemoteConnectionCredentials } from "./remote-access";
import type { RemoteWorkers, RemoteWorkerSummary } from "./remote-workers";
import { context } from "./runtime";
import { listWorkspaces } from "./workspaces";
import { DeliveryRecord } from "./orchestration-history";
import { OrchestrationDoc } from "./orchestration-state";
import { observeSession } from "./session-observer";
import { rpcEvents, splitByteStream } from "../shared/rpc";
import type { TranscriptImages } from "./transcript-images";
import { resolveSentFile } from "./send-files";
import { rpcError } from "./rpc-errors";
import {
  receiveWorkerFileStreams,
  validateWorkerFileMetadata,
  type WorkerFileMetadata,
} from "./worker-files";

/** A connection is bound during the authenticated upgrade, never by call payloads. */
export function authorizeNode(remotes: RemoteWorkers, connection: RemoteConnectionCredentials) {
  const current =
    connection.localGrantId && remotes.access.pairedConnection(connection.localGrantId);
  if (
    !current ||
    current.id !== connection.id ||
    current.instanceId !== connection.instanceId ||
    !remotes.access.listGrants().some((grant) => grant.id === connection.localGrantId)
  )
    throw new RpcError("UNAUTHORIZED", "Peer access removed");
  return connection.localGrantId!;
}

export async function unpairPeer(remotes: RemoteWorkers, grantId: string) {
  const connection = remotes.access.pairedConnection(grantId);
  if (!connection) throw new RpcError("UNAUTHORIZED", "Peer access removed");
  await remotes.access.removeConnection(connection.id);
  remotes.disconnect(connection.id);
  setImmediate(() => remotes.reverse.reconfigure());
}

/** Hashes and image handling stay in worker file admission. */
async function* fileParts(
  metadata: WorkerFileMetadata[],
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
) {
  let index = 0;
  for await (const stream of splitByteStream(
    body,
    metadata.map((file) => file.size),
    signal,
  ))
    yield { fieldname: `file-${index++}`, stream };
}

async function catalog(remotes: RemoteWorkers) {
  const workers: RemoteWorkerSummary[] = [];
  let cursor: string | undefined;
  do {
    const result = await remotes.runtime.orchestration.queryWorkers({
      action: "list",
      status: "all",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const page = JSON.parse((result.output as Array<{ text: string }>)[0]!.text) as {
      workers: RemoteWorkerSummary[];
      nextCursor?: string;
    };
    workers.push(...page.workers);
    cursor = page.nextCursor;
  } while (cursor);
  return workers;
}

/** Native peer domain operations. No owner routes, HTTP dispatcher or caller-supplied credentials. */
export function createNodeRpcHandler(
  remotes: RemoteWorkers,
  connection: RemoteConnectionCredentials,
): RpcHandler {
  const runtime = remotes.runtime;
  const grantId = connection.localGrantId!;
  const registry = rpcRegistry<NodeInputs, NodeOutputs, NodeEvents>();
  registry.add("node.identity", async () => ({ ...remotes.access.identity(), grantId }));
  registry.add("node.discovery", async () => {
    const main = await runtime.main.agent(context);
    authorizeNode(remotes, connection);
    return {
      workspaces: await listWorkspaces(runtime.config),
      models: await runtime.listModels(),
      defaultModel: main.model && `${main.model.provider}/${main.model.modelId}`,
    };
  });
  registry.add("node.unpair", async () => {
    // Once an authenticated removal is received it cannot be cancelled by
    // the caller immediately revoking its own side of the connection.
    await unpairPeer(remotes, grantId);
    return { ok: true };
  });
  registry.streaming(
    "node.command",
    async (input, call) => {
      const body = input;
      const command = body?.command;
      if (
        !command ||
        typeof body.requestId !== "string" ||
        !body.requestId.trim() ||
        !["run", "resume", "queue", "steer", "stop", "list", "inspect", "await"].includes(
          command.action,
        ) ||
        ("nodeId" in command && command.nodeId) ||
        ("files" in command && command.files !== undefined) ||
        command.sessionId?.startsWith("remote:")
      )
        throw new RpcError("BAD_INPUT", "Invalid node worker action or requestId");
      let files;
      if (body.files !== undefined) {
        validateWorkerFileMetadata(body.files);
        if (!["run", "queue", "resume", "steer"].includes(command.action) || !call.body)
          throw new RpcError(
            "BAD_INPUT",
            "Worker files require a supported action and binary body",
          );
        files = await receiveWorkerFileStreams(
          { rootDir: runtime.config.sentFilesDir, baseUrl: runtime.config.baseUrl },
          `node:${grantId}:${body.requestId}`,
          body.files,
          fileParts(body.files, call.body, call.signal),
        );
      } else if (call.body) throw new RpcError("BAD_INPUT", "Unexpected worker file body");
      call.signal.throwIfAborted();
      authorizeNode(remotes, connection);
      return {
        value: await runtime.orchestration.nodeCommand(grantId, body.requestId, command, files),
      };
    },
    { body: true },
  );
  registry.add("node.assignment", async (input) => {
    const { assignmentId } = input;
    if (!/^\d+$/.test(assignmentId)) throw new RpcError("BAD_INPUT", "Invalid assignment ID");
    const task = await runtime.harness.getTask(Number(assignmentId) as TaskId<string>, context);
    if (!task || task.kind !== "batty.delivery")
      throw new RpcError("NOT_FOUND", "Unknown worker assignment");
    authorizeNode(remotes, connection);
    return {
      status: task.state.status === "terminal" ? task.state.outcome.status : "running",
      ...(task.state.status === "terminal"
        ? {
            text:
              task.state.outcome.status === "faulted"
                ? task.state.outcome.error.message
                : task.state.outcome.status === "failed"
                  ? (task.state.outcome.result ?? task.state.outcome.error.message)
                  : task.state.outcome.result,
          }
        : {}),
      artifacts: (await runtime.harness.snapshot(DeliveryRecord, assignmentId, context))?.artifacts,
    };
  });
  registry.streaming("node.file", async (input, call) => {
    const file = input;
    if (
      !file ||
      [file.workspaceId, file.sessionId, file.toolCallId, file.fileId].some(
        (part) =>
          typeof part !== "string" ||
          !part ||
          part === "." ||
          part === ".." ||
          /[/\\\0]/.test(part),
      )
    )
      throw new RpcError("BAD_INPUT", "Invalid file identity");
    const resolved = await resolveSentFile({
      rootDir: runtime.config.sentFilesDir,
      workspaceId: file.workspaceId,
      sessionId: file.sessionId,
      toolCallId: file.toolCallId,
      fileId: file.fileId,
    });
    authorizeNode(remotes, connection);
    call.signal.throwIfAborted();
    return {
      value: resolved.descriptor,
      body: Readable.toWeb(createReadStream(resolved.storedPath)) as ReadableStream<Uint8Array>,
    };
  });
  registry.streaming("node.catalog.watch", async (input, call) => {
    return {
      value: null,
      events: rpcEvents(call.signal, (emit, signal, fail) => {
        let dirty = true;
        let forced = true;
        let workerRegistry: string | undefined;
        let flushing = false;
        const flush = async () => {
          if (flushing || signal.aborted) return;
          flushing = true;
          try {
            while (dirty && !signal.aborted) {
              dirty = false;
              const force = forced;
              forced = false;
              const state = (await runtime.harness.snapshot(OrchestrationDoc, context))!;
              const registry = JSON.stringify([
                state.mainId,
                Object.values(state.workers).map(({ id, workspaceId, active, startedAtMs }) => [
                  id,
                  workspaceId,
                  active,
                  startedAtMs,
                ]),
              ]);
              // Cron definitions, join bookkeeping and delivery receipts share the
              // orchestration document, but do not change the worker catalog.
              if (!force && registry === workerRegistry) continue;
              const workers = await catalog(remotes);
              authorizeNode(remotes, connection);
              await emit({ workers });
              workerRegistry = registry;
            }
          } catch (error) {
            if (!signal.aborted) fail(error);
          } finally {
            flushing = false;
          }
        };
        const observation = runtime.harness.observeCommits({
          advance(publication) {
            for (const change of publication.changes) {
              // Reports and terminal deliveries must still wake remote joins,
              // even when their visible worker summaries are unchanged.
              if (
                (change.type === "document" && change.record.kind === "batty.worker") ||
                (change.type === "task" &&
                  change.value.kind === "batty.delivery" &&
                  change.value.state.status === "terminal")
              ) {
                forced = true;
                dirty = true;
              } else if (
                change.type === "document" &&
                change.record.kind === OrchestrationDoc.definition.kind
              )
                dirty = true;
            }
            if (dirty) queueMicrotask(() => void flush());
          },
          end() {},
        });
        void flush();
        return () => observation.detach();
      }),
    };
  });
  registry.streaming("node.session.watch", async (input, call) => {
    const { sessionId, after = "0" } = input;
    if (!/^\d+$/.test(sessionId) || !/^\d+$/.test(after))
      throw new RpcError("BAD_INPUT", "Invalid worker cursor");
    const conversation = await runtime.conversation(sessionId);
    const metadata = await runtime.orchestration.metadata(conversation.id);
    if (!metadata?.isSubagent && !metadata?.isCron)
      throw new RpcError("NOT_FOUND", "Unknown worker");
    authorizeNode(remotes, connection);
    return {
      value: null,
      events: rpcEvents(call.signal, (emit, signal, fail) => {
        return observeSession(
          runtime,
          conversation.id,
          { state: async (state) => state } as TranscriptImages,
          after,
          async (event) => {
            if (signal.aborted) return;
            authorizeNode(remotes, connection);
            await emit(event);
          },
          signal,
          (error) => {
            if (!signal.aborted) fail(error);
          },
        );
      }),
    };
  });
  return async (operation, input, call): Promise<RpcReply> => {
    authorizeNode(remotes, connection);
    try {
      const handler = registry.operations.get(operation);
      if (!handler) throw new RpcError("FORBIDDEN", `Unknown peer operation: ${operation}`);
      return await handler(input, call);
    } catch (error) {
      throw rpcError(error);
    }
  };
}

/** Concatenation is streaming; metadata stays a separate JSON operation input. */
export function workerBody(files: Array<{ file: { storedPath: string } }>) {
  return Readable.toWeb(
    Readable.from(
      (async function* () {
        for (const file of files) yield* createReadStream(file.file.storedPath);
      })(),
    ),
  ) as ReadableStream<Uint8Array>;
}
