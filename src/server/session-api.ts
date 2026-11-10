import type { UserMessage } from "@earendil-works/pi-ai";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { RpcError, rpcRegistry, type RpcContext } from "../shared/rpc";
import type {
  OwnerInputs,
  OwnerOutputs,
  OwnerEvents,
  OwnerSessionEvent,
} from "../shared/owner-api";
import type { OwnerRpcServices } from "./owner-rpc";
import { Runtime, context } from "./runtime";
import { retainInput } from "./input-receipts";
import { preparePromptFiles, type UploadedFile } from "./uploads";
import { parseRemoteSession } from "./remote-workers";
import { observeSession } from "./session-observer";
import { observeAppStatus } from "./app-status-stream";
import { rpcEvents, splitByteStream } from "../shared/rpc";

function badInput(message: string): never {
  throw new RpcError("BAD_INPUT", message);
}

/** File metadata is sent once, followed by exactly the concatenated file bytes. */
async function promptFiles(
  metadata: OwnerInputs["main.submit"]["files"],
  rpc: RpcContext,
): Promise<UploadedFile[]> {
  if (!Array.isArray(metadata)) badInput("Invalid file metadata");
  for (const file of metadata) {
    if (
      typeof file.name !== "string" ||
      typeof file.type !== "string" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > 100 * 1024 * 1024
    )
      badInput("Invalid uploaded file");
  }
  if (!metadata.length && !rpc.body) return [];
  if (!rpc.body) badInput("Missing uploaded bytes");
  const result: UploadedFile[] = [];
  let index = 0;
  for await (const bytes of splitByteStream(
    rpc.body,
    metadata.map((file) => file.size),
    rpc.signal,
  )) {
    const file = metadata[index++]!;
    const data = Buffer.alloc(file.size);
    let offset = 0;
    for await (const chunk of bytes) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    result.push({ filename: file.name, mimetype: file.type, data });
  }
  return result;
}

/** Session operations composed into the owner's native RPC allowlist. */
export function createSessionOperations(
  runtime: Runtime,
  services: Pick<OwnerRpcServices, "transcriptImages"> & Partial<OwnerRpcServices>,
) {
  const { config } = runtime;
  const { transcriptImages: images, webPush } = services;
  const { operations, add, streaming } = rpcRegistry<OwnerInputs, OwnerOutputs, OwnerEvents>();
  add("session.get", async (input) =>
    images.state(await runtime.state(input.sessionId, undefined, true, input.after)),
  );
  add("session.messages", async (input) => {
    const page = await runtime.messages(input.sessionId, input.before, input.limit);
    return { ...page, messages: await images.messages(page.messages) };
  });
  add("session.resources", async ({ sessionId }) => {
    const agent = await (await runtime.conversation(sessionId)).agent(context);
    return {
      skills: (await runtime.resources.sessionSkills(agent.cwd ?? config.selfPath)).map(
        ({ name, description, filePath }) => ({ name, description, filePath }),
      ),
      tools: agent.tools.map(({ name, description }) => ({ name, description })),
    };
  });
  add("session.subagents", async ({ sessionId }) => {
    const conversation = await runtime.conversation(sessionId);
    const workers = await runtime.orchestration.listRunning(conversation.id);
    return [
      ...(await Promise.all(
        workers.map(async (worker) => {
          const agent = await (await runtime.conversation(worker.sessionId)).agent(context);
          return {
            ...worker,
            sessionPath: `durable:${worker.sessionId}`,
            parentSessionId: String(worker.parentId),
            model: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : undefined,
            thinkingLevel: agent.thinkingLevel,
            startedAtMs: worker.startedAtMs,
          };
        }),
      )),
      ...runtime.remotes.tasks(conversation.id),
    ];
  });
  add("session.stop", async ({ sessionId }) => {
    if (parseRemoteSession(sessionId)) await runtime.remotes.stop(sessionId);
    else await runtime.orchestration.stopWorker(sessionId);
    return { ok: true as const };
  });
  streaming("session.watch", async ({ sessionId, after }, rpc) => {
    const remote = parseRemoteSession(sessionId);
    const conversation = remote ? undefined : await runtime.conversation(sessionId);
    if (remote) await runtime.state(sessionId);
    const main = conversation?.id === runtime.main.id;
    return {
      value: {},
      events: rpcEvents<OwnerSessionEvent>(rpc.signal, (emit, signal) => {
        const stopSession = observeSession(
          runtime,
          conversation?.id ?? sessionId,
          images,
          after,
          emit,
          signal,
          console.error,
          remote
            ? {
                state: (history, cursor) => runtime.state(sessionId, undefined, history, cursor),
                subscribe: (changed) => {
                  let cursor = runtime.remotes.state(sessionId).historyCursor;
                  const update = () => {
                    const next = runtime.remotes.state(sessionId).historyCursor;
                    changed(next !== cursor);
                    cursor = next;
                  };
                  runtime.remotes.changes.on("change", update);
                  return () => {
                    runtime.remotes.changes.off("change", update);
                  };
                },
              }
            : undefined,
        );
        const stopStatus =
          main && services.buildId
            ? observeAppStatus(runtime, services.buildId, emit, signal, console.error)
            : undefined;
        const stopForeground =
          main && webPush
            ? webPush.foreground.connect((...[type, data]) => {
                if (type === "push-client") void emit({ type, ...data });
                else void emit({ type, ...data });
              })
            : undefined;
        return () => {
          stopSession();
          stopStatus?.();
          stopForeground?.();
        };
      }),
    };
  });
  add(
    "main.submit",
    async (input, rpc) => {
      if (
        !["prompt", "steer"].includes(input.kind) ||
        typeof input.text !== "string" ||
        (input.clientMessageId !== undefined && typeof input.clientMessageId !== "string")
      )
        badInput("Invalid prompt");
      if (input.correlationId && /^[a-f0-9-]{36}$/.test(input.correlationId))
        services.logSubmission?.(input.correlationId);
      const files = await promptFiles(input.files, rpc);
      rpc.signal.throwIfAborted();
      if (!input.text.trim() && !files.length) badInput("Missing message");
      const attachments = await preparePromptFiles(
        config.uploadsDir,
        String(runtime.main.id),
        files,
        config.baseUrl,
      );
      const wasBusy = (await runtime.state("main", undefined, false)).isStreaming;
      const content: UserMessage["content"] = [
        { type: "text", text: [input.text, attachments.text].filter(Boolean).join("\n\n") },
        ...attachments.images,
      ];
      await runtime.useDefaultModel();
      rpc.signal.throwIfAborted();
      const submission = await runtime.main.submit(
        {
          type: "input",
          content,
          requestId: input.clientMessageId,
          whenBusy: input.kind === "steer" ? "steer" : "followUp",
        },
        context,
      );
      await retainInput(runtime.main, submission.id, content, input.clientMessageId);
      return {
        disposition: wasBusy ? ("queued" as const) : ("started" as const),
        submissionId: String(submission.id),
        sessionId: String(runtime.main.id),
      };
    },
    { body: true },
  );
  add("main.stop", async () => {
    await runtime.tools.abortConversation(runtime.main.id);
    await runtime.main.abort(context);
    return { ok: true as const };
  });
  add("main.queue.remove", async ({ index }) => {
    await runtime.harness.abortSubmission(Number(index) as SubmissionId, context, runtime.main.id);
    return runtime.state();
  });
  return operations;
}
