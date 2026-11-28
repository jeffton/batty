import type { QueuedPrompt } from "@/shared/types";
import { decodeRuntimeNotice } from "./runtime-notices";

export function queuedPromptDisplay(
  content: string | { type: string; text?: string }[],
): Pick<QueuedPrompt, "text" | "runtimeNoticeKind"> {
  const notice = decodeRuntimeNotice(content);
  if (notice?.kind === "system" || notice?.kind === "owner") return { text: notice.text };
  if (notice) {
    const display = notice.data?.runtimeNotice as { text: string; markdown: string } | undefined;
    return {
      runtimeNoticeKind: notice.kind,
      text: display
        ? [display.text, display.markdown].join("\n")
        : notice.kind === "cron"
          ? "Scheduled task"
          : "Subagent task",
    };
  }
  return {
    text:
      typeof content === "string"
        ? content
        : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
  };
}
