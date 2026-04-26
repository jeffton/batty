import type { AgentSession } from "@mariozechner/pi-coding-agent";

export const BATTY_RUNTIME_NOTICE_CUSTOM_TYPE = "batty-runtime-notice";

export type RuntimeNoticeKind = "cron" | "subagent";

export interface RuntimeNotice {
  kind: RuntimeNoticeKind;
  text: string;
}

export function buildCronRuntimeNotice({
  scheduleLabel,
  prompt,
  now = new Date(),
}: {
  scheduleLabel: string;
  prompt: string;
  now?: Date;
}): RuntimeNotice {
  const lines = [
    `Cron run triggered. Current time: ${formatLocalDateTime(now)}. Schedule: ${scheduleLabel}`,
    "",
    "Prompt:",
    prompt.trim(),
  ];

  return {
    kind: "cron",
    text: lines.join("\n"),
  };
}

export function buildSubagentRuntimeNotice(): RuntimeNotice {
  return {
    kind: "subagent",
    text: "Subagent run started. Do not call the subagent tool from this session.",
  };
}

export function buildRuntimeNoticeMessage(
  notice: RuntimeNotice,
  timestamp: number,
): AgentSession["messages"][number] {
  return {
    role: "custom",
    customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:${notice.kind}`,
    content: notice.text,
    timestamp,
  } as AgentSession["messages"][number];
}

function formatLocalDateTime(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
