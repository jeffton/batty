import fs from "node:fs/promises";
import path from "node:path";
import type { SiteCatalog, VisitedSite } from "@/shared/owner-api";
import { missingFile, publishJson } from "./artifact-storage";
import type { AppConfig } from "./config";
import { stateDirPath } from "./options";
import { getSite, listStoredSites } from "./sites";

export class SiteRecents {
  private writes = Promise.resolve();

  constructor(private readonly config: Pick<AppConfig, "battyDir" | "sitesDir" | "baseUrl">) {}

  private get filename() {
    return path.join(stateDirPath(this.config.battyDir), "site-recents.json");
  }

  async catalog(): Promise<SiteCatalog> {
    await this.writes;
    const [sites, recents] = await Promise.all([this.sites(), this.read()]);
    return this.order(sites, recents);
  }

  open(siteId: string): Promise<VisitedSite> {
    const write = this.writes.then(async () => {
      const [sites, recents] = await Promise.all([this.sites(), this.read()]);
      const ready = sites.find((site) => site.id === siteId);
      if (!ready) {
        const { descriptor } = await getSite(this.config.sitesDir, this.config.baseUrl, siteId);
        return { ...this.order(sites, recents), site: descriptor };
      }
      const updated = [siteId, ...recents.filter((id) => id !== siteId)];
      if (recents[0] !== siteId) {
        await fs.mkdir(path.dirname(this.filename), { recursive: true });
        await publishJson(this.filename, updated);
      }
      return { ...this.order(sites, updated), site: ready };
    });
    this.writes = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private async read(): Promise<string[]> {
    try {
      return JSON.parse(await fs.readFile(this.filename, "utf8")) as string[];
    } catch (error) {
      if (missingFile(error)) return [];
      throw error;
    }
  }

  private async sites() {
    return (await listStoredSites(this.config.sitesDir, this.config.baseUrl))
      .sort((a, b) => b.createdAt - a.createdAt || a.site.id.localeCompare(b.site.id))
      .map(({ site }) => site);
  }

  private order(sites: SiteCatalog["sites"], recents: string[]): SiteCatalog {
    const remaining = new Map(sites.map((site) => [site.id, site]));
    const opened = recents.flatMap((id) => {
      const site = remaining.get(id);
      if (!site) return [];
      remaining.delete(id);
      return [site];
    });
    return { sites: [...opened, ...remaining.values()] };
  }
}
