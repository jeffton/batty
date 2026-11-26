import type { SentFileDescriptor, SiteDescriptor } from "./types";

interface ArtifactLibraryFields {
  ref: string;
  title: string;
  createdAt: string;
  starred: boolean;
}

export type ArtifactLibraryItem = ArtifactLibraryFields &
  (
    | { kind: "file"; source: "upload" | "generated"; file: SentFileDescriptor }
    | { kind: "site"; site: SiteDescriptor }
  );

export interface ArtifactLibraryResponse {
  artifacts: ArtifactLibraryItem[];
}

export const fileLibraryRef = (id: string) => `file:${id}`;
export const siteLibraryRef = (id: string) => `site:${id}`;
