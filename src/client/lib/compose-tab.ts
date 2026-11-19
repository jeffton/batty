import { recoverComposerSlots, listComposerTabs, draftStorageKey } from "./drafts-db";

const storageKey = () => draftStorageKey("compose-tab");
const lockName = (tab: string) => draftStorageKey(`compose-tab:${tab}`);
let pageTab: Promise<string> | undefined;

async function reserve(tab: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    void navigator.locks
      .request(lockName(tab), { ifAvailable: true }, (lock) => {
        resolve(Boolean(lock));
        // A document owns its slot for its lifetime; destruction releases it.
        if (lock) return new Promise<void>(() => {});
        return undefined;
      })
      .catch(reject);
  });
}

export function getComposeTab(): Promise<string> {
  return (pageTab ??= (async () => {
    const remembered = sessionStorage.getItem(storageKey());
    if (remembered && (await reserve(remembered))) {
      await recoverComposerSlots(remembered, true);
      return remembered;
    }
    const tab = crypto.randomUUID();
    await reserve(tab);
    sessionStorage.setItem(storageKey(), tab);
    return tab;
  })());
}

export async function recoverClosedTabs(tab: string): Promise<void> {
  for (const owner of await listComposerTabs()) {
    if (owner === tab) continue;
    await navigator.locks.request(lockName(owner), { ifAvailable: true }, async (lock) => {
      if (lock) await recoverComposerSlots(owner);
    });
  }
}
