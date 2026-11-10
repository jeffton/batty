import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { TaskId } from "@earendil-works/pi-durable";
import { RpcError, type RpcHandler, type RpcReply } from "../shared/rpc";
import type { RemoteConnectionCredentials } from "./remote-access";
import type { RemoteWorkers, RemoteWorkerSummary } from "./remote-workers";
import { context } from "./runtime";
import { listWorkspaces } from "./workspaces";
import { DeliveryRecord } from "./orchestration-history";
import { observeSession } from "./session-sse";
import { rpcEvents } from "./rpc-events";
import type { TranscriptImages } from "./transcript-images";
import { resolveSentFile } from "./send-files";
import type { WorkerCommand } from "./orchestration-workers";
import {
  receiveWorkerFileStreams,
  validateWorkerFileMetadata,
  type WorkerFileMetadata,
} from "./worker-files";

export type NodeCommandInput = {
  requestId: string;
  command: WorkerCommand;
  files?: WorkerFileMetadata[];
};

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

/** Manifest lengths delimit concatenated bytes; hashes and image handling stay in file admission. */
async function* fileParts(metadata: WorkerFileMetadata[], body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  let pending: Uint8Array = new Uint8Array();
  let ended = false;
  try {
    for (const [index, file] of metadata.entries()) {
      async function* bytes() {
        let remaining = file.size;
        while (remaining > 0) {
          if (!pending.byteLength) {
            const chunk = await reader.read();
            if (chunk.done) {
              ended = true;
              throw new RpcError("BAD_INPUT", "Missing worker file bytes");
            }
            pending = chunk.value;
          }
          const length = Math.min(remaining, pending.byteLength);
          const part = pending.subarray(0, length);
          pending = pending.subarray(length);
          remaining -= length;
          yield part;
        }
      }
      yield { fieldname: `file-${index}`, stream: bytes() };
    }
    if (pending.byteLength || !(await reader.read()).done)
      throw new RpcError("BAD_INPUT", "Unexpected worker file bytes");
    ended = true;
  } finally {
    if (!ended) await reader.cancel();
    reader.releaseLock();
  }
}

async function catalog(remotes: RemoteWorkers) {
  const workers: RemoteWorkerSummary[] = [];
  let cursor: string | undefined;
  do {
    const result = await remotes.runtime.orchestration.queryWorkers({
      action: "list",
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
  return async (operation, input, call): Promise<RpcReply> => {
    const grantId = authorizeNode(remotes, connection);
    try {
      switch (operation) {
        case "node.identity":
          return { value: { ...remotes.access.identity(), grantId } };
        case "node.discovery": {
          const main = await runtime.main.agent(context);
          authorizeNode(remotes, connection);
          return {
            value: {
              workspaces: await listWorkspaces(runtime.config),
              models: await runtime.listModels(),
              defaultModel: main.model && `${main.model.provider}/${main.model.modelId}`,
            },
          };
        }
        case "node.unpair":
          // Once an authenticated removal is received it cannot be cancelled by
          // the caller immediately revoking its own side of the connection.
          await unpairPeer(remotes, grantId);
          return { value: { ok: true } };
        case "node.command": {
          const body = input as NodeCommandInput;
          const command = body?.command;
          if (
            !command ||
            typeof body.requestId !== "string" ||
            !body.requestId.trim() ||
            !["run", "resume", "queue", "steer", "stop", "list", "inspect", "await"].includes(
              command.action,
            ) ||
            command.nodeId ||
            command.files !== undefined ||
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
              fileParts(body.files, call.body),
            );
          } else if (call.body) throw new RpcError("BAD_INPUT", "Unexpected worker file body");
          call.signal.throwIfAborted();
          authorizeNode(remotes, connection);
          return {
            value: await runtime.orchestration.nodeCommand(grantId, body.requestId, command, files),
          };
        }
        case "node.assignment": {
          const { assignmentId } = input as { assignmentId: string };
          if (!/^\d+$/.test(assignmentId)) throw new RpcError("BAD_INPUT", "Invalid assignment ID");
          const task = await runtime.harness.getTask(
            Number(assignmentId) as TaskId<string>,
            context,
          );
          if (!task || task.kind !== "batty.delivery")
            throw new RpcError("NOT_FOUND", "Unknown worker assignment");
          authorizeNode(remotes, connection);
          return {
            value: {
              status: task.state.status === "terminal" ? task.state.outcome.status : "running",
              ...(task.state.status === "terminal" && task.state.outcome.status === "completed"
                ? { text: task.state.outcome.result }
                : {}),
              artifacts: (await runtime.harness.snapshot(DeliveryRecord, assignmentId, context))
                ?.artifacts,
            },
          };
        }
        case "node.file": {
          const file = input as {
            workspaceId: string;
            sessionId: string;
            toolCallId: string;
            fileId: string;
          };
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
            body: Readable.toWeb(
              createReadStream(resolved.storedPath),
            ) as ReadableStream<Uint8Array>,
          };
        }
        case "node.catalog.watch":
          return {
            value: null,
            events: rpcEvents(call.signal, (emit, signal, fail) => {
              let dirty = true;
              let flushing = false;
              const flush = async () => {
                if (flushing || signal.aborted) return;
                flushing = true;
                try {
                  while (dirty && !signal.aborted) {
                    dirty = false;
                    const workers = await catalog(remotes);
                    authorizeNode(remotes, connection);
                    await emit({ workers });
                  }
                } catch (error) {
                  if (!signal.aborted) fail(error);
                } finally {
                  flushing = false;
                }
              };
              const observation = runtime.harness.observeCommits({
                advance(publication) {
                  if (
                    publication.changes.some(
                      (change) =>
                        (change.type === "document" &&
                          ["batty.worker", "batty.orchestration"].includes(change.record.kind)) ||
                        (change.type === "task" &&
                          change.value.kind === "batty.delivery" &&
                          change.value.state.status === "terminal"),
                    )
                  ) {
                    dirty = true;
                    queueMicrotask(() => void flush());
                  }
                },
                end() {},
              });
              void flush();
              return () => observation.detach();
            }),
          };
        case "node.session.watch": {
          const { sessionId, after = "0" } = input as { sessionId: string; after?: string };
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
        }
        default:
          throw new RpcError("FORBIDDEN", `Unknown peer operation: ${operation}`);
      }
    } catch (error) {
      if (error instanceof RpcError) throw error;
      const status = (error as { statusCode?: number; code?: string }).statusCode;
      const code =
        status === 400
          ? "BAD_INPUT"
          : status === 404 || (error as { code?: string }).code === "ENOENT"
            ? "NOT_FOUND"
            : "INTERNAL";
      throw new RpcError(code, error instanceof Error ? error.message : String(error));
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
