import { computed, reactive, watch, type ComputedRef } from "vue";
import { resolveThinkingOptions } from "@/client/lib/thinking-levels";
import type { useAppStore } from "@/client/stores/app";
import type { CronJob } from "@/shared/types";

export interface CronDraft {
  enabled: boolean;
  prompt: string;
  model: string;
  thinkingLevel: string;
  sessionKind: CronJob["session"]["kind"];
  includePreviousContext: boolean;
  editing: boolean;
  saving: boolean;
  toggling: boolean;
  deleting: boolean;
  error: string;
}

type AppStore = ReturnType<typeof useAppStore>;

function includePreviousContextFor(job: CronJob): boolean {
  return job.session.kind === "daily-detached"
    ? job.session.includePreviousContext === true
    : false;
}

function sessionPatchFromDraft(draft: CronDraft): CronJob["session"] {
  if (draft.sessionKind === "daily-detached") {
    return { kind: "daily-detached", includePreviousContext: draft.includePreviousContext };
  }
  if (draft.sessionKind === "daily-inline") {
    return { kind: "daily-inline" };
  }
  return { kind: "new" };
}

export function useCronJobDrafts(store: AppStore): {
  jobs: ComputedRef<CronJob[]>;
  draftFor: (job: CronJob) => CronDraft;
  editJob: (job: CronJob) => void;
  cancelEdit: (job: CronJob) => void;
  thinkingOptions: (job: CronJob) => string[];
  sessionLabel: (job: CronJob) => string;
  saveJob: (job: CronJob) => Promise<void>;
  toggleJob: (job: CronJob) => Promise<void>;
  deleteJob: (job: CronJob) => Promise<void>;
} {
  const drafts = reactive<Record<string, CronDraft>>({});
  const jobs = computed(() => store.workspaceCronJobs);

  function ensureDraft(job: CronJob): CronDraft {
    const existing = drafts[job.id];
    if (existing) {
      return existing;
    }

    const created: CronDraft = {
      enabled: job.enabled,
      prompt: job.prompt,
      model: job.model,
      thinkingLevel: job.thinkingLevel,
      sessionKind: job.session.kind,
      includePreviousContext: includePreviousContextFor(job),
      editing: false,
      saving: false,
      toggling: false,
      deleting: false,
      error: "",
    };
    drafts[job.id] = created;
    return created;
  }

  function syncDrafts(nextJobs: CronJob[]): void {
    const activeIds = new Set(nextJobs.map((job) => job.id));
    for (const job of nextJobs) {
      const draft = ensureDraft(job);
      if (!draft.saving && !draft.toggling) {
        draft.enabled = job.enabled;
        draft.prompt = job.prompt;
        draft.model = job.model;
        draft.thinkingLevel = job.thinkingLevel;
        draft.sessionKind = job.session.kind;
        draft.includePreviousContext = includePreviousContextFor(job);
        draft.error = "";
      }
    }

    for (const jobId of Object.keys(drafts)) {
      if (!activeIds.has(jobId)) {
        delete drafts[jobId];
      }
    }
  }

  function draftFor(job: CronJob): CronDraft {
    return ensureDraft(job);
  }

  function resetDraft(job: CronJob): void {
    const draft = draftFor(job);
    draft.enabled = job.enabled;
    draft.prompt = job.prompt;
    draft.model = job.model;
    draft.thinkingLevel = job.thinkingLevel;
    draft.sessionKind = job.session.kind;
    draft.includePreviousContext = includePreviousContextFor(job);
    draft.error = "";
  }

  function editJob(job: CronJob): void {
    for (const [jobId, draft] of Object.entries(drafts)) {
      draft.editing = jobId === job.id;
    }
    resetDraft(job);
    draftFor(job).editing = true;
  }

  function cancelEdit(job: CronJob): void {
    resetDraft(job);
    draftFor(job).editing = false;
  }

  function thinkingOptions(job: CronJob): string[] {
    const draft = draftFor(job);
    if (store.activeSession?.model !== draft.model) {
      return [];
    }

    return resolveThinkingOptions(store.activeSession);
  }

  function sessionLabel(job: CronJob): string {
    switch (job.session.kind) {
      case "new":
        return "new";
      case "daily-inline":
        return "daily · inline";
      case "daily-detached":
        return job.session.includePreviousContext === true
          ? "daily · detached · with previous context"
          : "daily · detached · fresh context";
    }
  }

  async function saveJob(job: CronJob): Promise<void> {
    const draft = draftFor(job);
    const patch = {
      prompt: draft.prompt,
      model: draft.model,
      thinkingLevel: draft.thinkingLevel,
      session: sessionPatchFromDraft(draft),
    };

    draft.saving = true;
    draft.error = "";
    draft.editing = false;
    try {
      const updated = await store.updateCronJob(job.id, patch);
      draft.prompt = updated.prompt;
      draft.model = updated.model;
      draft.thinkingLevel = updated.thinkingLevel;
      draft.sessionKind = updated.session.kind;
      draft.includePreviousContext = includePreviousContextFor(updated);
    } catch (error) {
      draft.error = error instanceof Error ? error.message : String(error);
      draft.editing = true;
    } finally {
      draft.saving = false;
    }
  }

  async function toggleJob(job: CronJob): Promise<void> {
    const draft = draftFor(job);
    draft.toggling = true;
    draft.error = "";
    try {
      const updated = await store.updateCronJob(job.id, { enabled: draft.enabled });
      draft.enabled = updated.enabled;
    } catch (error) {
      draft.enabled = job.enabled;
      draft.error = error instanceof Error ? error.message : String(error);
    } finally {
      draft.toggling = false;
    }
  }

  async function deleteJob(job: CronJob): Promise<void> {
    const draft = draftFor(job);
    draft.deleting = true;
    draft.error = "";
    try {
      await store.deleteCronJob(job.id);
    } catch (error) {
      draft.error = error instanceof Error ? error.message : String(error);
      draft.deleting = false;
    }
  }

  watch(
    jobs,
    (nextJobs) => {
      syncDrafts(nextJobs);
    },
    { immediate: true },
  );

  return {
    jobs,
    draftFor,
    editJob,
    cancelEdit,
    thinkingOptions,
    sessionLabel,
    saveJob,
    toggleJob,
    deleteJob,
  };
}
