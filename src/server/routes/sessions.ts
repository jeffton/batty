import type { FastifyInstance } from "fastify";
import type { UserMessage } from "@earendil-works/pi-ai";
import { type Runtime, context } from "../runtime";
import type { TranscriptImages } from "../transcript-images";
import { retainInput } from "../input-receipts";
import { preparePromptFiles, type UploadedFile } from "../uploads";
import { streamSession } from "../session-sse";

/** Shared HTTP boundary for archive pages, live projections and accepted inputs. */
export function registerSessionRoutes(
  app: FastifyInstance,
  runtime: Runtime,
  transcriptImages: TranscriptImages,
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

  const eventStreams = new Set<import("node:http").ServerResponse>();
  for (const url of ["/api/main/events", "/api/sessions/:sessionId/events"]) {
    app.get<{ Params: { sessionId?: string }; Querystring: { after?: string } }>(
      url,
      async (request, reply) => {
        const conversation = await runtime.conversation(request.params.sessionId ?? "main");
        reply.hijack();
        eventStreams.add(reply.raw);
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
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
