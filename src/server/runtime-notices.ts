import type { AgentSession } from "@mariozechner/pi-coding-agent";

export const BATTY_RUNTIME_NOTICE_CUSTOM_TYPE = "batty-runtime-notice";

export type RuntimeNoticeKind = "cron" | "subagent";

export interface RuntimeNotice {
  kind: RuntimeNoticeKind;
  text: string;
  systemPrompt: string;
}

export interface RuntimeNoticeEntryData {
  kind: RuntimeNoticeKind;
  text: string;
  timestamp: number;
}

type AgentMessage = AgentSession["messages"][number];

type SessionEntry = {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
};

export function buildCronRuntimeNotice(scheduleLabel: string): RuntimeNotice {
  return {
    kind: "cron",
    text: `Cron run triggered. Schedule: ${scheduleLabel}`,
    systemPrompt: [
      "[Batty cron turn]",
      "This turn was triggered by a Batty cron job.",
      `Schedule: ${scheduleLabel}`,
    ].join("\n"),
  };
}

export function buildSubagentRuntimeNotice(): RuntimeNotice {
  return {
    kind: "subagent",
    text: "Subagent run started. Do not call the subagent tool from this session.",
    systemPrompt: [
      "[Batty subagent turn]",
      "You are running inside a Batty subagent.",
      "Do not call the subagent tool from this session.",
    ].join("\n"),
  };
}

export function buildRuntimeNoticeEntryData(
  notice: RuntimeNotice,
  timestamp: number,
): RuntimeNoticeEntryData {
  return {
    kind: notice.kind,
    text: notice.text,
    timestamp,
  };
}

export function runtimeNoticeMessageFromEntry(
  entry: SessionEntry | undefined,
): AgentMessage | undefined {
  if (entry?.type !== "custom" || entry.customType !== BATTY_RUNTIME_NOTICE_CUSTOM_TYPE) {
    return undefined;
  }

  const data = entry.data;
  if (!data || typeof data !== "object") {
    return undefined;
  }

  const candidate = data as Partial<RuntimeNoticeEntryData>;
  if (
    (candidate.kind !== "cron" && candidate.kind !== "subagent") ||
    typeof candidate.text !== "string" ||
    typeof candidate.timestamp !== "number"
  ) {
    return undefined;
  }

  return {
    role: "custom",
    customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:${candidate.kind}`,
    content: candidate.text,
    timestamp: candidate.timestamp,
  } as AgentMessage;
}
