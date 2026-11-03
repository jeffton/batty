import { installationStorageKey } from "./installation-storage";

type RetryPrompt = {
  clientMessageId: string;
  payload: string;
};

const prefix = `${installationStorageKey("prompt-retry")}:`;
function storageKey(sessionId: string): string {
  return `${prefix}${encodeURIComponent(sessionId)}`;
}
function payloadKey(kind: "prompt" | "steer", text: string, files: File[]): string {
  return JSON.stringify({
    kind,
    text,
    files: files.map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
    })),
  });
}

// A transport failure does not mean that the server rejected the submission.
// Keep the same receipt key while the restored draft has the same payload.
export function promptSubmissionId(
  sessionId: string,
  kind: "prompt" | "steer",
  text: string,
  files: File[],
): string {
  const payload = payloadKey(kind, text, files);
  const stored = localStorage.getItem(storageKey(sessionId));
  if (stored) {
    const retry = JSON.parse(stored) as RetryPrompt;
    if (retry.payload === payload) return retry.clientMessageId;
    localStorage.removeItem(storageKey(sessionId));
  }
  return crypto.randomUUID();
}

export function retainPromptRetry(
  sessionId: string,
  kind: "prompt" | "steer",
  text: string,
  files: File[],
  clientMessageId: string,
): void {
  localStorage.setItem(
    storageKey(sessionId),
    JSON.stringify({
      clientMessageId,
      payload: payloadKey(kind, text, files),
    } satisfies RetryPrompt),
  );
}

export function clearPromptRetry(sessionId: string, clientMessageId: string): void {
  const stored = localStorage.getItem(storageKey(sessionId));
  if (stored && (JSON.parse(stored) as RetryPrompt).clientMessageId === clientMessageId)
    localStorage.removeItem(storageKey(sessionId));
}
