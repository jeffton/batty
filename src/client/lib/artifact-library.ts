import type { ArtifactLibraryResponse } from "@/shared/artifact-library";
import { withBaseUrl } from "./base-url";

async function requestArtifacts(
  path: string,
  init?: RequestInit,
): Promise<ArtifactLibraryResponse> {
  const response = await fetch(withBaseUrl(path), { credentials: "include", ...init });
  if (!response.ok) {
    throw new Error(`Artifact library request failed (HTTP ${response.status}).`);
  }
  return response.json();
}

export function getArtifacts(): Promise<ArtifactLibraryResponse> {
  return requestArtifacts("/api/artifacts");
}

export function setArtifactStar(ref: string, starred: boolean): Promise<ArtifactLibraryResponse> {
  return requestArtifacts("/api/artifacts/star", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref, starred }),
  });
}
