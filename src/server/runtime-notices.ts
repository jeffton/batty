import type { AgentSession } from "@mariozechner/pi-coding-agent";

export const BATTY_RUNTIME_NOTICE_CUSTOM_TYPE = "batty-runtime-notice";

export type RuntimeNoticeKind = "cron" | "subagent";

export interface RuntimeNotice {
  kind: RuntimeNoticeKind;
  text: string;
}

export function buildCronRuntimeNotice(scheduleLabel: string): RuntimeNotice {
  return {
    kind: "cron",
    text: `Cron run triggered. Schedule: ${scheduleLabel}`,
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
