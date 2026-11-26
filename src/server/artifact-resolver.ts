import type { SentFileDescriptor, SiteDescriptor } from "@/shared/types";
import type { AppConfig } from "./config";
import { storedSentFiles } from "./send-files";
import { getSite } from "./sites";
import { storedUploadedFiles } from "./uploads";

function missingRef(ref: string) {
  return Object.assign(new Error(`Artifact not found: ${ref}`), { statusCode: 404 });
}

type ResolvedArtifacts = { sentFiles: SentFileDescriptor[]; sites: SiteDescriptor[] };

export class ArtifactResolver {
  constructor(
    private readonly config: Pick<
      AppConfig,
      "sentFilesDir" | "uploadsDir" | "sitesDir" | "baseUrl"
    >,
  ) {}

  async resolve(refs: readonly string[]): Promise<ResolvedArtifacts> {
    const ordered = await Promise.all(
      [...new Set(refs)].map((ref) =>
        ref.startsWith("site:") ? this.findSite(ref) : this.findFile(ref).then(({ file }) => file),
      ),
    );
    return {
      sentFiles: ordered.filter((item): item is SentFileDescriptor => "downloadUrl" in item),
      sites: ordered.filter((item): item is SiteDescriptor => "url" in item),
    };
  }

  async resolveFileSource(ref: string): Promise<{ name: string; path: string }> {
    const { file, storedPath } = await this.findFile(ref);
    return { name: file.name, path: storedPath };
  }

  private async findSite(ref: string): Promise<SiteDescriptor> {
    const { sitesDir, baseUrl } = this.config;
    try {
      return (await getSite(sitesDir, baseUrl, ref.slice("site:".length))).descriptor;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) throw missingRef(ref);
      throw error;
    }
  }

  private async findFile(ref: string) {
    if (!ref.startsWith("file:")) throw missingRef(ref);
    const id = ref.slice("file:".length);
    const { sentFilesDir, uploadsDir, baseUrl } = this.config;
    if (/^[0-9a-f]{64}$/.test(id)) {
      for await (const { file, storedPath } of storedUploadedFiles(uploadsDir, baseUrl, id))
        return { file, storedPath };
    } else {
      for await (const { file, storedPath } of storedSentFiles(sentFilesDir, baseUrl, id))
        return { file, storedPath };
    }
    throw missingRef(ref);
  }
}
