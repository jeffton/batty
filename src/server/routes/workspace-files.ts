import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { WorkspaceFilesResponse, WorkspaceFileSearchEvent } from "@/shared/workspace-files";
import { searchWorkspaceFileNames, withinWorkspace as within } from "../workspace-file-search";
import type { AppConfig } from "../config";
import { listWorkspaces } from "../workspaces";

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

export function registerWorkspaceFileRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get<{ Params: { workspaceId: string }; Querystring: { name: string } }>(
    "/api/workspaces/:workspaceId/file-search",
    async (request, reply) => {
      const workspace = (await listWorkspaces(config)).find(
        (candidate) => candidate.id === request.params.workspaceId,
      );
      if (!workspace) throw httpError(404, "Workspace not found");
      if (!request.query.name) throw httpError(400, "File name is required");
      const root = await fs.realpath(workspace.path);
      const controller = new AbortController();
      reply.raw.once("close", () => controller.abort());
      async function* events(): AsyncGenerator<string> {
        const encode = (event: WorkspaceFileSearchEvent) => `${JSON.stringify(event)}\n`;
        try {
          for await (const filePath of searchWorkspaceFileNames(
            root,
            request.query.name,
            controller.signal,
          )) {
            yield encode({ kind: "match", path: filePath });
          }
          yield encode({ kind: "done" });
        } catch (cause) {
          if (!controller.signal.aborted)
            yield encode({
              kind: "error",
              message: cause instanceof Error ? cause.message : String(cause),
            });
        }
      }
      return reply
        .type("application/x-ndjson")
        .header("X-Accel-Buffering", "no")
        .send(Readable.from(events()));
    },
  );
  app.get<{ Params: { workspaceId: string }; Querystring: { path?: string } }>(
    "/api/workspaces/:workspaceId/files",
    async (request): Promise<WorkspaceFilesResponse> => {
      const workspace = (await listWorkspaces(config)).find(
        (candidate) => candidate.id === request.params.workspaceId,
      );
      if (!workspace) throw httpError(404, "Workspace not found");
      const requested = request.query.path ?? "";
      if (
        requested.includes("\0") ||
        requested.includes("\\") ||
        path.posix.isAbsolute(requested) ||
        path.win32.isAbsolute(requested) ||
        requested.split("/").includes("..")
      )
        throw httpError(400, "Path must stay inside the workspace");

      try {
        const root = await fs.realpath(workspace.path);
        const target = await fs.realpath(path.resolve(root, requested));
        if (!within(root, target)) throw httpError(403, "Path leaves the workspace");
        const stat = await fs.stat(target);
        if (stat.isDirectory()) {
          const children = await fs.readdir(target, { withFileTypes: true });
          const entries = await Promise.all(
            children.map(async (entry) => {
              let directory = entry.isDirectory();
              if (entry.isSymbolicLink()) {
                // Resolve only for classification; opening a link still checks containment.
                try {
                  const link = await fs.realpath(path.join(target, entry.name));
                  directory = within(root, link) && (await fs.stat(link)).isDirectory();
                } catch (cause) {
                  if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
                }
              }
              return {
                path: path.posix.join(requested, entry.name),
                kind: directory ? ("directory" as const) : ("file" as const),
              };
            }),
          );
          entries.sort(
            (a, b) =>
              Number(b.kind === "directory") - Number(a.kind === "directory") ||
              a.path.localeCompare(b.path),
          );
          return { kind: "directory", path: requested, entries };
        }
        if (!stat.isFile()) return { kind: "unsupported", path: requested };
        const bytes = await fs.readFile(target);
        if (bytes.includes(0)) return { kind: "binary", path: requested };
        try {
          return {
            kind: "text",
            path: requested,
            contents: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          };
        } catch {
          return { kind: "binary", path: requested };
        }
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") throw httpError(404, "File not found");
        throw cause;
      }
    },
  );
}
