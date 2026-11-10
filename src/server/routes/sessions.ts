import type { FastifyInstance } from "fastify";
import { Runtime } from "../runtime";
import type { TranscriptImages } from "../transcript-images";
import type { UploadedFile } from "../uploads";
import { streamSession } from "../session-sse";
import type { PushForeground } from "../push-foreground";
import { parseRemoteSession } from "../remote-workers";
import { createSessionOperations } from "../session-api";

/** HTTP compatibility controllers use the same direct session operations as native RPC. */
export function registerSessionRoutes(
  app: FastifyInstance,
  runtime: Runtime,
  transcriptImages: TranscriptImages,
  foreground?: PushForeground,
  connectAppStatus?: (stream: import("node:http").ServerResponse) => void,
) {
  const operations = createSessionOperations(runtime, { transcriptImages });
  const call = async (operation: string, input: unknown, body?: ReadableStream<Uint8Array>) => {
    try {
      return (
        await operations.get(operation)!(input, { signal: new AbortController().signal, body })
      ).value;
    } catch (error) {
      const failure = error as Error & { code?: string };
      if (failure.code === "BAD_INPUT") Object.assign(failure, { statusCode: 400 });
      throw error;
    }
  };
  app.get<{ Querystring: { after?: string } }>("/api/main", (request) =>
    call("session.get", { sessionId: "main", after: request.query.after }),
  );
  app.get<{ Querystring: { before?: string; limit?: string } }>("/api/main/messages", (request) =>
    call("session.messages", {
      sessionId: "main",
      before: request.query.before,
      limit: request.query.limit ? Number(request.query.limit) : undefined,
    }),
  );
  app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", (request) =>
    call("session.get", request.params),
  );
  app.get<{ Params: { sessionId: string }; Querystring: { before?: string; limit?: string } }>(
    "/api/sessions/:sessionId/messages",
    (request) =>
      call("session.messages", {
        ...request.params,
        before: request.query.before,
        limit: request.query.limit ? Number(request.query.limit) : undefined,
      }),
  );
  app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/subagents", (request) =>
    call("session.subagents", request.params),
  );
  app.post<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/stop", (request) =>
    call("session.stop", request.params),
  );

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
  for (const [url, kind] of [
    ["/api/main/prompt", "prompt"],
    ["/api/main/steer", "steer"],
  ] as const) {
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
      let index = 0;
      const body = files.length
        ? new ReadableStream<Uint8Array>({
            pull(controller) {
              const file = files[index++];
              if (file) controller.enqueue(file.data);
              else controller.close();
            },
          })
        : undefined;
      return call(
        "main.submit",
        {
          kind,
          text,
          clientMessageId,
          files: files.map((file) => ({
            name: file.filename,
            type: file.mimetype ?? "",
            size: file.data.length,
          })),
        },
        body,
      );
    });
  }
  return () => {
    for (const stream of eventStreams) stream.end();
  };
}
