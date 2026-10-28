import type { FastifyInstance } from "fastify";
import type { UserMessage } from "@earendil-works/pi-ai";
import { type Runtime, context } from "../runtime";
import type { TranscriptImages } from "../transcript-images";
import { retainInput } from "../input-receipts";
import { preparePromptFiles, type UploadedFile } from "../uploads";
import { streamSession } from "../session-sse";
import type { PushForeground } from "../push-foreground";
import { parseRemoteSession } from "../remote-workers";

/** Shared HTTP boundary for archive pages, live projections and accepted inputs. */
export function registerSessionRoutes(
  app: FastifyInstance,
  runtime: Runtime,
  transcriptImages: TranscriptImages,
  foreground?: PushForeground,
  connectAppStatus?: (stream: import("node:http").ServerResponse) => void,
) {
  const config = runtime.config;
  app.get<{ Querystring: { after?: string } }>("/api/main", async (request) =>
    transcriptImages.state(await runtime.state("main", undefined, true, request.query.after)),
  );
  app.get<{ Querystring: { before?: string; limit?: string } }>(
    "/api/main/messages",
    async (request) => {
      const page = await runtime.messages(
        "main",
        request.query.before,
        request.query.limit ? Number(request.query.limit) : undefined,
      );
      return { ...page, messages: await transcriptImages.messages(page.messages) };
    },
  );
  app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request) =>
    transcriptImages.state(await runtime.state(request.params.sessionId)),
  );
  app.get<{ Params: { sessionId: string }; Querystring: { before?: string; limit?: string } }>(
    "/api/sessions/:sessionId/messages",
    async (request) => {
      const page = await runtime.messages(
        request.params.sessionId,
        request.query.before,
        request.query.limit ? Number(request.query.limit) : undefined,
      );
      return { ...page, messages: await transcriptImages.messages(page.messages) };
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/subagents",
    async (request) => {
      const conversation = await runtime.conversation(request.params.sessionId);
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
    },
  );

  app.post<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/stop", async (request) => {
    if (parseRemoteSession(request.params.sessionId))
      await runtime.remotes.stop(request.params.sessionId);
    else await runtime.orchestration.stopWorker(request.params.sessionId);
    return { ok: true };
  });

  const eventStreams = new Set<import("node:http").ServerResponse>();
  for (const url of ["/api/main/events", "/api/sessions/:sessionId/events"]) {
    app.get<{ Params: { sessionId?: string }; Querystring: { after?: string } }>(
      url,
      async (request, reply) => {
        const id = request.params.sessionId ?? "main";
        if (parseRemoteSession(id)) {
          // Read-only local projection: viewing history also works while the peer is offline.
          await runtime.state(id);
          reply.hijack();
          eventStreams.add(reply.raw);
          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
          });
          streamSession(
            reply.raw,
            runtime,
            id,
            transcriptImages,
            request.query.after,
            (error) => app.log.error(error),
            {
              state: (history, after) => runtime.state(id, undefined, history, after),
              subscribe: (changed) => {
                let cursor = runtime.remotes.state(id).historyCursor;
                const update = () => {
                  const next = runtime.remotes.state(id).historyCursor;
                  changed(next !== cursor);
                  cursor = next;
                };
                runtime.remotes.changes.on("change", update);
                return () => runtime.remotes.changes.off("change", update);
              },
            },
          );
          reply.raw.once("close", () => eventStreams.delete(reply.raw));
          return;
        }
        const conversation = await runtime.conversation(id);
        reply.hijack();
        eventStreams.add(reply.raw);
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        if (conversation.id === runtime.main.id) connectAppStatus?.(reply.raw);
        const disconnectForeground = foreground?.connect((event, data) => {
          if (!reply.raw.destroyed && !reply.raw.writableEnded && !reply.raw.writableNeedDrain)
            reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        });
        reply.raw.once("close", () => disconnectForeground?.());
        streamSession(
          reply.raw,
          runtime,
          conversation.id,
          transcriptImages,
          request.query.after,
          (error) => app.log.error(error),
        );
        reply.raw.once("close", () => eventStreams.delete(reply.raw));
      },
    );
  }
  for (const url of ["/api/main/prompt", "/api/main/steer"]) {
    app.post(url, async (request) => {
      let text = "",
        clientMessageId: string | undefined;
      const files: UploadedFile[] = [];
      if (request.isMultipart()) {
        for await (const part of request.parts()) {
          if (part.type === "file")
            files.push({
              filename: part.filename,
              mimetype: part.mimetype,
              data: await part.toBuffer(),
            });
          else if (part.fieldname === "text") text = String(part.value);
          else if (part.fieldname === "clientMessageId") clientMessageId = String(part.value);
        }
      } else {
        const body = request.body as { text: string; clientMessageId?: string };
        text = body.text;
        clientMessageId = body.clientMessageId;
      }
      if (!text.trim() && !files.length)
        throw Object.assign(new Error("Missing message"), { statusCode: 400 });
      const attachments = await preparePromptFiles(
        config.uploadsDir,
        String(runtime.main.id),
        files,
        config.baseUrl,
      );
      const wasBusy = (await runtime.state("main", undefined, false)).isStreaming;
      const content: UserMessage["content"] = [
        { type: "text", text: [text, attachments.text].filter(Boolean).join("\n\n") },
        ...attachments.images,
      ];
      await runtime.useDefaultModel();
      const submission = await runtime.main.submit(
        {
          type: "input",
          content,
          requestId: clientMessageId,
          whenBusy: url.endsWith("steer") ? "steer" : "followUp",
        },
        context,
      );
      await retainInput(runtime.main, submission.id, content, clientMessageId);
      return {
        disposition: wasBusy ? "queued" : "started",
        submissionId: String(submission.id),
        sessionId: String(runtime.main.id),
      };
    });
  }

  return () => {
    for (const stream of eventStreams) stream.end();
  };
}
