import type { FastifyInstance } from "fastify";
import type { ArtifactLibraryResponse } from "@/shared/artifact-library";
import type { ArtifactLibrary } from "../artifact-library";

export function registerArtifactRoutes(app: FastifyInstance, library: ArtifactLibrary) {
  app.get<{ Reply: ArtifactLibraryResponse }>("/api/artifacts", async () => ({
    artifacts: await library.list(),
  }));
  app.put<{ Body: { ref: string; starred: boolean }; Reply: ArtifactLibraryResponse }>(
    "/api/artifacts/star",
    {
      schema: {
        body: {
          type: "object",
          required: ["ref", "starred"],
          properties: { ref: { type: "string", minLength: 1 }, starred: { type: "boolean" } },
        },
      },
    },
    async (request) => ({
      artifacts: await library.setStar(request.body.ref, request.body.starred),
    }),
  );
}
