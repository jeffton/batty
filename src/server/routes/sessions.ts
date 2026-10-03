import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { listWorkspaces, resolveWorkspace } from "../workspaces";
import { resolveSentFile } from "../send-files";
import { resolveUploadedFile } from "../pi-service-uploads";
import type { UploadedFile } from "../pi-service";
import type { ServerEvent } from "@/shared/types";
import type { RouteContext } from "./context";
import { startEventStream } from "./event-stream";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseClientMessageId(value: string | undefined): string {
  if (!value || !UUID_PATTERN.test(value)) {
    throw Object.assign(new Error("A valid clientMessageId is required"), { statusCode: 400 });
  }
  return value;
}

function formatContentDisposition(filename: string, disposition: "attachment" | "inline"): string {
  const fallback = filename.replace(/[^\x20-\x7e]+/g, "_").replace(/"/g, "");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback || "download"}"; filename*=UTF-8''${encoded}`;
}

function parseRangeHeader(
  rangeHeader: string,
  size: number,
): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return undefined;
  }

  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (!startText && !endText) {
    return undefined;
  }

  if (!startText) {
    const suffixLength = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return undefined;
    }
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number.parseInt(startText, 10);
  const end = endText ? Number.parseInt(endText, 10) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    return undefined;
  }

  if (start >= size) {
    return { start: size, end: size - 1 };
  }

  return {
    start,
    end: Math.min(end, size - 1),
  };
}

async function ensureSessionLoaded(
  context: RouteContext,
  sessionId: string,
  options?: { workspaceId?: string; sessionPath?: string },
): Promise<void> {
  if (context.service.hasSession(sessionId)) {
    return;
  }

  const workspaceId = options?.workspaceId;
  const sessionPath = options?.sessionPath;
  if (!workspaceId || !sessionPath) {
    throw Object.assign(new Error(`Unknown session: ${sessionId}`), { statusCode: 404 });
  }

  const workspaces = await listWorkspaces(context.config);
  const workspace = resolveWorkspace(workspaces, workspaceId);
  const restoredSession = await context.service.openSession(workspace, sessionPath);
  if (restoredSession.sessionId !== sessionId) {
    throw Object.assign(new Error(`Session id mismatch: ${sessionId}`), { statusCode: 409 });
  }
}

export function registerSessionRoutes(context: RouteContext): void {
  const { app, config, service, routePath } = context;

  app.post<{ Body: { workspaceId: string } }>(routePath("/api/sessions"), async (request) => {
    const workspaces = await listWorkspaces(config);
    const workspace = resolveWorkspace(workspaces, request.body.workspaceId);
    const session = await service.createSession(workspace);
    return service.getSnapshot(session.id);
  });

  app.post<{ Body: { workspaceId: string } }>(routePath("/api/sessions/daily"), async (request) => {
    const workspaces = await listWorkspaces(config);
    const workspace = resolveWorkspace(workspaces, request.body.workspaceId);
    const session = await service.createOrOpenDailySession(workspace);
    return service.getSnapshot(session.id);
  });

  app.post<{
    Body: {
      workspaceId: string;
      sessionPath: string;
      messagesDetailLevel?: "summary" | "full";
    };
  }>(routePath("/api/sessions/open"), async (request) => {
    const workspaces = await listWorkspaces(config);
    const workspace = resolveWorkspace(workspaces, request.body.workspaceId);
    const session = await service.openSession(workspace, request.body.sessionPath);
    return service.getSnapshot(session.id);
  });

  app.post<{ Body: { workspaceId: string; sessionId: string } }>(
    routePath("/api/sessions/open-by-id"),
    async (request) => {
      const workspaces = await listWorkspaces(config);
      const workspace = resolveWorkspace(workspaces, request.body.workspaceId);
      const session = await service.openSessionById(workspace, request.body.sessionId);
      return service.getSnapshot(session.id);
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    routePath("/api/sessions/:sessionId"),
    async (request) => {
      return service.getSnapshot(request.params.sessionId);
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    routePath("/api/sessions/:sessionId/resources"),
    async (request) => service.getSessionResources(request.params.sessionId),
  );

  app.get<{ Params: { sessionId: string } }>(
    routePath("/api/sessions/:sessionId/subagents"),
    async (request) => service.listRunningSubagents(request.params.sessionId),
  );

  app.post<{
    Params: { sessionId: string };
    Body: { workspaceId: string; readThrough: number };
  }>(routePath("/api/sessions/:sessionId/read"), async (request) => {
    const workspaces = await listWorkspaces(config);
    const workspace = resolveWorkspace(workspaces, request.body.workspaceId);
    await service.markSessionRead(workspace, request.params.sessionId, request.body.readThrough);
    return { ok: true };
  });

  app.get<{
    Params: { sessionId: string };
    Querystring: {
      before?: string;
      limit?: string;
      throughEntryId?: string;
      workspaceId?: string;
      sessionPath?: string;
    };
  }>(routePath("/api/sessions/:sessionId/messages"), async (request) => {
    await ensureSessionLoaded(context, request.params.sessionId, {
      ...(request.query.workspaceId ? { workspaceId: request.query.workspaceId } : {}),
      ...(request.query.sessionPath ? { sessionPath: request.query.sessionPath } : {}),
    });

    const parsedLimit = Number.parseInt(request.query.limit ?? "", 10);
    const throughEntryId =
      request.query.throughEntryId === undefined ? undefined : Number(request.query.throughEntryId);
    if (
      throughEntryId !== undefined &&
      (!Number.isSafeInteger(throughEntryId) || throughEntryId < 0)
    )
      throw Object.assign(new Error("throughEntryId must be a non-negative integer"), {
        statusCode: 400,
      });
    return service.getSessionMessages(request.params.sessionId, {
      ...(request.query.before ? { beforeMessageId: request.query.before } : {}),
      ...(Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {}),
      ...(throughEntryId !== undefined ? { throughEntryId } : {}),
    });
  });

  app.post<{ Params: { sessionId: string }; Body: { modelId: string } }>(
    routePath("/api/sessions/:sessionId/model"),
    async (request) => {
      await service.setModel(request.params.sessionId, request.body.modelId);
      return service.getSnapshot(request.params.sessionId);
    },
  );

  app.post<{ Params: { sessionId: string }; Body: { thinkingLevel: string } }>(
    routePath("/api/sessions/:sessionId/thinking"),
    async (request) => {
      await service.setThinkingLevel(request.params.sessionId, request.body.thinkingLevel);
      return service.getSnapshot(request.params.sessionId);
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    routePath("/api/sessions/:sessionId/prompt"),
    async (request) => {
      const files: UploadedFile[] = [];
      let text = "";
      let clientMessageId: string | undefined;
      let streamingBehavior: "steer" | "followUp" | undefined;

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === "file") {
          files.push({
            filename: part.filename,
            data: await part.toBuffer(),
          });
        } else if (part.fieldname === "text") {
          text = String(part.value ?? "");
        } else if (part.fieldname === "clientMessageId") {
          clientMessageId = String(part.value ?? "");
        } else if (part.fieldname === "streamingBehavior") {
          const value = String(part.value ?? "");
          if (value === "steer" || value === "followUp") {
            streamingBehavior = value;
          }
        }
      }

      return service.prompt(
        request.params.sessionId,
        text,
        files,
        parseClientMessageId(clientMessageId),
        streamingBehavior,
      );
    },
  );

  app.delete<{
    Params: { sessionId: string; submissionId: string };
  }>(routePath("/api/sessions/:sessionId/queue/:submissionId"), async (request) => {
    const submissionId = Number.parseInt(request.params.submissionId, 10);
    await service.removeQueuedPrompt(request.params.sessionId, submissionId);
    return service.getSnapshot(request.params.sessionId);
  });

  app.post<{ Params: { sessionId: string } }>(
    routePath("/api/sessions/:sessionId/abort"),
    async (request) => {
      await service.abort(request.params.sessionId);
      return { ok: true };
    },
  );

  app.get<{
    Params: { sessionId: string };
    Querystring: {
      workspaceId?: string;
      sessionPath?: string;
    };
  }>(routePath("/api/sessions/:sessionId/events"), async (request, reply) => {
    await ensureSessionLoaded(context, request.params.sessionId, {
      ...(request.query.workspaceId ? { workspaceId: request.query.workspaceId } : {}),
      ...(request.query.sessionPath ? { sessionPath: request.query.sessionPath } : {}),
    });

    startEventStream(reply.raw);

    let closed = false;
    let unsubscribe: (() => void) | undefined;
    const send = (payload: ServerEvent) => {
      if (!closed) reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      reply.raw.write(": keep-alive\n\n");
    }, 15000);
    request.raw.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe?.();
      reply.raw.end();
    });
    unsubscribe = await service.subscribe(request.params.sessionId, send);
    if (closed) unsubscribe();
  });

  app.get<{
    Params: { workspaceId: string; sessionId: string; name: string };
  }>(routePath("/api/session-images/:workspaceId/:sessionId/:name"), async (request, reply) => {
    const resolved = await service.resolveSessionImage(
      request.params.workspaceId,
      request.params.sessionId,
      request.params.name,
    );
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    reply.header("Content-Type", resolved.mimeType);
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(createReadStream(resolved.path));
  });

  app.get<{
    Params: { sessionId: string; batchId: string; storedName: string };
  }>(routePath("/api/uploads/:sessionId/:batchId/:storedName"), async (request, reply) => {
    const resolved = await resolveUploadedFile(
      config.uploadsDir,
      request.params.sessionId,
      request.params.batchId,
      request.params.storedName,
    );
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    reply.header("Content-Type", resolved.mimeType);
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(createReadStream(resolved.path));
  });

  app.get<{
    Params: { workspaceId: string; sessionId: string; toolCallId: string; fileId: string };
    Querystring: { download?: string };
  }>(
    routePath("/api/sent-files/:workspaceId/:sessionId/:toolCallId/:fileId"),
    async (request, reply) => {
      const resolved = await resolveSentFile({
        rootDir: config.sentFilesDir,
        baseUrl: config.baseUrl,
        workspaceId: request.params.workspaceId,
        sessionId: request.params.sessionId,
        toolCallId: request.params.toolCallId,
        fileId: request.params.fileId,
      });
      const stats = await fs.stat(resolved.storedPath);
      const download = request.query.download === "1";

      reply.header("Accept-Ranges", "bytes");
      reply.header("Cache-Control", "private, max-age=31536000, immutable");
      reply.header("Content-Type", resolved.descriptor.mimeType);
      reply.header(
        "Content-Disposition",
        formatContentDisposition(resolved.descriptor.name, download ? "attachment" : "inline"),
      );
      reply.header("X-Content-Type-Options", "nosniff");

      if (!download && typeof request.headers.range === "string") {
        const range = parseRangeHeader(request.headers.range, stats.size);
        if (!range || range.start >= stats.size) {
          reply.code(416);
          reply.header("Content-Range", `bytes */${stats.size}`);
          return reply.send();
        }

        reply.code(206);
        reply.header("Content-Length", String(range.end - range.start + 1));
        reply.header("Content-Range", `bytes ${range.start}-${range.end}/${stats.size}`);
        return reply.send(
          createReadStream(resolved.storedPath, { start: range.start, end: range.end }),
        );
      }

      reply.header("Content-Length", String(stats.size));
      return reply.send(createReadStream(resolved.storedPath));
    },
  );
}
