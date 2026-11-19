import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from "vue";
import { syncDrafts } from "./draft-sync";
import { draftStorageKey, listDraftRecords, type Draft } from "./drafts-db";

const SYNC_INTERVAL_MS = 15_000;

export function useDrafts(enabled: Readonly<Ref<boolean>>, online: Readonly<Ref<boolean>>) {
  const drafts = shallowRef<Draft[]>([]);
  const syncError = ref("");
  const storageError = ref("");
  let channel: BroadcastChannel | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let syncing: AbortController | undefined;
  let queued = false;
  let reading = 0;
  let mounted = false;

  async function refresh() {
    const version = ++reading;
    try {
      const records = await listDraftRecords();
      if (version !== reading) return;
      drafts.value = records
        .flatMap(({ draft }) => (draft ? [draft] : []))
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
      storageError.value = "";
    } catch (error) {
      if (version === reading) storageError.value = `Could not read drafts: ${String(error)}`;
    }
  }

  async function synchronize() {
    if (!mounted || !enabled.value || !online.value || !navigator.onLine) return;
    if (syncing) {
      queued = true;
      return;
    }
    const controller = new AbortController();
    syncing = controller;
    try {
      await syncDrafts(controller.signal);
      syncError.value = "";
    } catch (error) {
      if (!controller.signal.aborted)
        syncError.value = String(error instanceof Error ? error.message : error);
    } finally {
      if (mounted && !controller.signal.aborted) {
        await refresh();
        channel?.postMessage("changed");
      }
      syncing = undefined;
      if (queued) {
        queued = false;
        void synchronize();
      }
    }
  }

  function changed() {
    void refresh();
    channel?.postMessage("changed");
    void synchronize();
  }
  function wake() {
    if (document.visibilityState !== "visible" || !enabled.value) return;
    void refresh();
    void synchronize();
  }
  function pause() {
    syncing?.abort();
  }
  function activate() {
    if (!mounted || !enabled.value || channel) return;
    channel = new BroadcastChannel(draftStorageKey("updates"));
    channel.onmessage = () => void refresh();
    timer = setInterval(wake, SYNC_INTERVAL_MS);
    void refresh();
    void synchronize();
  }

  watch(online, (value) => (value ? void synchronize() : pause()));
  watch(enabled, activate);
  onMounted(() => {
    mounted = true;
    window.addEventListener("online", wake);
    window.addEventListener("offline", pause);
    document.addEventListener("visibilitychange", wake);
    activate();
  });
  onBeforeUnmount(() => {
    mounted = false;
    reading += 1;
    pause();
    clearInterval(timer);
    channel?.close();
    window.removeEventListener("online", wake);
    window.removeEventListener("offline", pause);
    document.removeEventListener("visibilitychange", wake);
  });
  return { drafts, error: computed(() => storageError.value || syncError.value), changed, wake };
}
