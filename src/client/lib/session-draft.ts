const SESSION_DRAFT_STORAGE_PREFIX = "batty:session-draft:";

export function sessionDraftStorageKey(sessionId: string): string {
  return `${SESSION_DRAFT_STORAGE_PREFIX}${encodeURIComponent(sessionId)}`;
}

export function readSessionDraft(sessionId: string): string {
  try {
    return window.localStorage.getItem(sessionDraftStorageKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

export function writeSessionDraft(sessionId: string, text: string): void {
  try {
    if (text.length === 0) {
      window.localStorage.removeItem(sessionDraftStorageKey(sessionId));
      return;
    }

    window.localStorage.setItem(sessionDraftStorageKey(sessionId), text);
  } catch {
    // Ignore storage errors; drafts are best-effort.
  }
}

export function clearSessionDraft(sessionId: string): void {
  writeSessionDraft(sessionId, "");
}
