import type { SentFileDescriptor } from "@/shared/types";

export const ATTACHMENT_DELIVERY_INSTRUCTION =
  "Attachments belong to the current agent's response. To deliver relevant existing files from a report, call attach_artifacts with the listed file refs in your own turn; this preserves their IDs without copying. Use attach_files to import local files by path. Copying attachment:// links does not deliver attachments. Choose the relevant files; do not automatically forward every draft.";

export function reportWithAttachments(
  text: string,
  files: readonly SentFileDescriptor[] = [],
): string {
  const stored = files.filter((file) => file.storedPath !== undefined);
  if (!stored.length) return text;
  return [
    text,
    "Files attached in this execution scope (name and stored absolute local path):",
    ...stored.map((file) => JSON.stringify({ name: file.name, path: file.storedPath })),
    ATTACHMENT_DELIVERY_INSTRUCTION,
  ].join("\n\n");
}
