import { withBaseUrl } from "./base-url";
import {
  acknowledgeDraft,
  draftScope,
  importDraft,
  listDraftRecords,
  observeDraftDeletion,
  type Draft,
  type DraftRecord,
} from "./drafts-db";

type RemoteDraft = Omit<Draft, "files"> & {
  files: { name: string; type: string; lastModified: number }[];
};

async function request(path: string, signal: AbortSignal, init?: RequestInit) {
  const response = await fetch(withBaseUrl(`/api/drafts${path}`), {
    ...init,
    credentials: "same-origin",
    headers: { "X-Batty-Draft-Scope": draftScope() ?? "" },
    signal,
  });
  if (!response.ok) throw new DraftHttpError(response.status);
  return response;
}

class DraftHttpError extends Error {
  constructor(readonly status: number) {
    super(`Draft sync failed (HTTP ${status})`);
  }
}

async function send(record: DraftRecord, signal: AbortSignal): Promise<void> {
  const path = `/${record.id}`;
  const draft = record.draft;
  if (!draft) {
    await request(path, signal, { method: "DELETE" });
  } else {
    const body = new FormData();
    body.append("text", draft.text);
    body.append("createdAt", String(draft.createdAt));
    if (draft.retryId) body.append("retryId", draft.retryId);
    body.append("lastModified", JSON.stringify(draft.files.map((file) => file.lastModified)));
    body.append(
      "fileMetadata",
      JSON.stringify(draft.files.map(({ name, type }) => ({ name, type }))),
    );
    for (const file of draft.files) body.append("file", file);
    await request(path, signal, { method: "PUT", body });
  }
  signal.throwIfAborted();
  await acknowledgeDraft(record);
}

export async function syncDrafts(signal: AbortSignal): Promise<void> {
  let uploadError: unknown;
  for (const record of await listDraftRecords()) {
    signal.throwIfAborted();
    if (!record.pending) continue;
    try {
      await send(record, signal);
    } catch (error) {
      signal.throwIfAborted();
      // An individual upload failure must not block independent saves/deletes.
      if (!(error instanceof DraftHttpError) || [401, 403].includes(error.status)) throw error;
      uploadError ??= error;
    }
  }
  const local = new Map((await listDraftRecords()).map((record) => [record.id, record]));
  const response = await request("", signal);
  const { drafts } = (await response.json()) as { drafts: RemoteDraft[] };
  const live = new Set(drafts.map((draft) => draft.id));
  signal.throwIfAborted();
  for (const { id, draft, pending } of local.values()) {
    if (draft && !pending && !live.has(id)) await observeDraftDeletion(id);
  }
  for (const draft of drafts) {
    if (local.has(draft.id)) continue;
    const files: File[] = [];
    try {
      for (const [index, file] of draft.files.entries()) {
        const bytes = await (await request(`/${draft.id}/files/${index}`, signal)).blob();
        files.push(new File([bytes], file.name, file));
      }
    } catch (error) {
      // Another client can consume/delete between listing and downloading.
      if (error instanceof DraftHttpError && error.status === 404) continue;
      throw error;
    }
    signal.throwIfAborted();
    await importDraft({ ...draft, files });
  }
  if (uploadError) throw uploadError;
}
