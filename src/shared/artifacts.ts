import type { SentFileDescriptor } from "./types";

export const fileArtifactRef = (id: string) => `file:${id}`;
export const siteArtifactRef = (id: string) => `site:${id}`;

export function isTextArtifactCandidate({
  name,
  mimeType,
}: Pick<SentFileDescriptor, "name" | "mimeType">) {
  return (
    mimeType.startsWith("text/") ||
    /^application\/(?:json|javascript|xml|sql|toml|yaml|x-yaml|x-sh|x-httpd-php|x-ndjson|[^/]+\+(?:json|xml))$/.test(
      mimeType,
    ) ||
    /\.(?:log|md|ts|tsx|jsx|vue|svelte|py|rb|rs|go|sh|fish|ps1|jsonl|toml|ini|cfg|conf|h|c|cc|cpp|cs|java|kt|swift|lua|diff|patch|env|graphql|tf)$/i.test(
      name,
    ) ||
    /^(?:Dockerfile|Makefile|Gemfile|README|LICENSE|\.gitignore|\.gitattributes)$/i.test(name)
  );
}

export function artifactTextUrl(downloadUrl: string) {
  return `${downloadUrl.split("?")[0]}?text=1`;
}
