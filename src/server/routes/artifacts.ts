import type { FastifyInstance } from "fastify";
import type { ArtifactLibraryResponse } from "@/shared/artifact-library";
import { ArtifactCatalogChanged, type ArtifactLibrary } from "../artifact-library";

const pageLength = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
const defaultPageLength = 50;

export function registerArtifactRoutes(app: FastifyInstance, library: ArtifactLibrary) {
  app.get<{ Querystring: { limit?: number; after?: string } }>(
    "/api/artifacts",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { limit: pageLength, after: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      try {
        return await library.page(request.query.limit ?? defaultPageLength, request.query.after);
      } catch (error) {
        if (!(error instanceof ArtifactCatalogChanged)) throw error;
        return reply.code(409).send({ code: "ARTIFACT_CATALOG_CHANGED", error: error.message });
      }
    },
  );
  app.put<{
    Body: { ref: string; starred: boolean; limit?: number };
    Reply: ArtifactLibraryResponse;
  }>(
    "/api/artifacts/star",
    {
      schema: {
        body: {
          type: "object",
          required: ["ref", "starred"],
          properties: {
            ref: { type: "string", minLength: 1 },
            starred: { type: "boolean" },
            limit: pageLength,
          },
        },
      },
    },
    (request) =>
      library.setStar(
        request.body.ref,
        request.body.starred,
        request.body.limit ?? defaultPageLength,
      ),
  );
}
