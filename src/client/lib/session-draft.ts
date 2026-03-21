const SESSION_DRAFT_STORAGE_PREFIX = "batty:session-draft:";

export function sessionDraftStorageKey(sessionId: string): string {
  return `${SESSION_DRAFT_STORAGE_PREFIX}${encodeURIComponent(sessionId)}`;
}

export function readSessionDraft(sessionId: string): string {
  if (typeof window === "undefined") {
    return "";
  }

  try {
    return window.localStorage.getItem(sessionDraftStorageKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

export function writeSessionDraft(sessionId: string, text: string): void {
  if (typeof window === "undefined") {
    return;
  }

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
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(sessionDraftStorageKey(sessionId));
  } catch {
    // Ignore storage errors; drafts are best-effort.
  }
}
