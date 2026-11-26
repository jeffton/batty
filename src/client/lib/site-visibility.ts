import { reactive, readonly } from "vue";
import { getSite, setSitePublic } from "./api";

const visibility = reactive(new Map<string, { public: boolean; revision: number }>());
const saving = reactive(new Set<string>());
let revision = 0;

export const savingSiteVisibility = readonly(saving);

export function confirmedSitePublic(siteId: string): boolean | undefined {
  return visibility.get(siteId)?.public;
}

export async function loadSiteVisibility(siteId: string, signal: AbortSignal): Promise<void> {
  const requested = ++revision;
  const site = await getSite(siteId, signal);
  signal.throwIfAborted();
  const current = visibility.get(siteId);
  if (!current || current.revision < requested) {
    visibility.set(siteId, { public: site.public, revision: requested });
  }
}

export async function saveSiteVisibility(siteId: string, isPublic: boolean): Promise<void> {
  if (saving.has(siteId)) return;
  saving.add(siteId);
  try {
    const site = await setSitePublic(siteId, isPublic);
    visibility.set(siteId, { public: site.public, revision: ++revision });
  } finally {
    saving.delete(siteId);
  }
}
