import type { ArtifactLibraryResponse } from "@/shared/artifact-library";
import { withBaseUrl } from "./base-url";

export class ArtifactCatalogChanged extends Error {}

async function requestArtifacts(
  path: string,
  init?: RequestInit,
): Promise<ArtifactLibraryResponse> {
  const response = await fetch(withBaseUrl(path), { credentials: "include", ...init });
  if (!response.ok) {
    if (response.status === 409 && (await response.json()).code === "ARTIFACT_CATALOG_CHANGED") {
      throw new ArtifactCatalogChanged("Artifact list changed.");
    }
    throw new Error(`Artifact library request failed (HTTP ${response.status}).`);
  }
  return response.json();
}

const pageSize = 50;

export function getArtifacts(
  after: string | undefined,
  signal: AbortSignal,
): Promise<ArtifactLibraryResponse> {
  const query = new URLSearchParams({ limit: String(pageSize) });
  if (after !== undefined) query.set("after", after);
  return requestArtifacts(`/api/artifacts?${query}`, { signal });
}

export function setArtifactStar(ref: string, starred: boolean): Promise<ArtifactLibraryResponse> {
  return requestArtifacts("/api/artifacts/star", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref, starred, limit: pageSize }),
  });
}
