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

export function buildCronRuntimeNotice(scheduleLabel: string, now = new Date()): RuntimeNotice {
  return {
    kind: "cron",
    text: `Cron run triggered. Schedule: ${scheduleLabel}`,
    systemPrompt: [
      "[Batty cron turn]",
      "This turn was triggered by a Batty cron job.",
      `Schedule: ${scheduleLabel}`,
      `Current local date and time: ${formatLocalDateTime(now)}`,
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

function formatLocalDateTime(date: Date): string {
  const isoDate = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  const dayOfWeek = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
  }).format(date);

  return `${isoDate} ${time} (${dayOfWeek})`;
}
