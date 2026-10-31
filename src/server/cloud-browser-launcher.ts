import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { workspaceBrowserKey, type BrowserService } from "./browser-service";

export async function cloudBrowserAvailable(platform = process.platform): Promise<boolean> {
  if (platform !== "linux") return false;
  const directories = (process.env.PATH ?? "").split(path.delimiter);
  return (
    await Promise.all(
      ["Xvfb", "xauth", "ffmpeg"].map(async (name) =>
        (
          await Promise.all(
            directories.map(async (directory) => {
              try {
                await fs.access(path.join(directory, name), fs.constants.X_OK);
                return true;
              } catch (error) {
                if (
                  ["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code!)
                )
                  return false;
                throw error;
              }
            }),
          )
        ).some(Boolean),
      ),
    )
  ).every(Boolean);
}

export function registerCloudBrowserLauncher(
  app: FastifyInstance,
  browser: BrowserService,
  baseUrl: string,
  available: boolean,
  workspaceIds: () => Promise<string[]>,
): void {
  app.post<{ Body: { workspaceId: string } }>(
    "/api/cloud-browser/open",
    {
      schema: {
        body: Type.Object(
          { workspaceId: Type.String({ minLength: 1 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (
        request.headers.origin !== new URL(baseUrl, `${request.protocol}://${request.host}`).origin
      )
        return reply.code(403).send({ error: "Same-origin browser control required." });
      if (!available)
        return reply.code(501).send({ error: "Cloud browser is unavailable on this host." });
      if (!(await workspaceIds()).includes(request.body.workspaceId))
        return reply.code(404).send({ error: "Workspace not found." });
      return browser.openCloudBrowser(workspaceBrowserKey(request.body.workspaceId));
    },
  );
}
