import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const BATTY_RUNTIME_NOTICE_CUSTOM_TYPE = "batty-runtime-notice";
const NOTICE_OPEN = "<batty-runtime-notice>";
const NOTICE_CLOSE = "</batty-runtime-notice>";
export type RuntimeNoticeKind = "cron" | "subagent";
export interface RuntimeNotice {
  kind: RuntimeNoticeKind;
  text: string;
  data?: Record<string, unknown>;
}

// Durable inputs use provider-compatible user messages. The envelope preserves
// their application type through queued admission, storage.
export function encodeRuntimeNotice(notice: RuntimeNotice): string {
  return `${NOTICE_OPEN}${JSON.stringify(notice)}${NOTICE_CLOSE}`;
}
export function decodeRuntimeNotice(content: unknown): RuntimeNotice | undefined {
  if (Array.isArray(content)) {
    if (content.length !== 1 || content[0]?.type !== "text") return undefined;
    content = content[0].text;
  }
  if (typeof content !== "string" || !content.startsWith(NOTICE_OPEN)) return undefined;
  if (!content.endsWith(NOTICE_CLOSE)) return undefined;
  try {
    const notice = JSON.parse(content.slice(NOTICE_OPEN.length, -NOTICE_CLOSE.length));
    if (!notice || !["cron", "subagent"].includes(notice.kind) || typeof notice.text !== "string")
      return undefined;
    return notice;
  } catch {
    return undefined;
  }
}

export function buildSubagentRuntimeNotice(_depth: number, prompt: string): RuntimeNotice {
  return {
    kind: "subagent",
    text: [
      "You are a subagent carrying out an assigned task, not the main assistant. Work only on this task in this execution scope.",
      "Make your final response self-contained.",
      "Assigned task:",
      prompt.trim(),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export function buildSubagentSteeringRuntimeNotice(prompt: string): RuntimeNotice {
  return { kind: "subagent", text: `Steering message from the calling agent:\n\n${prompt.trim()}` };
}

export function buildCronRuntimeNotice({
  scheduleLabel,
  prompt,
  session,
  phase = "run",
  now = new Date(),
}: {
  scheduleLabel: string;
  prompt: string;
  session: { kind: string };
  phase?: "run" | "delivery" | "skipped";
  now?: Date;
}): RuntimeNotice {
  const inline = session.kind === "daily-inline" || session.kind === "main-inline";
  return {
    kind: "cron",
    text: [
      `Cron ${phase === "run" ? "run triggered" : phase === "delivery" ? "result delivered" : "run skipped"}. Current time: ${now.toISOString()}. Schedule: ${scheduleLabel}.`,
      ...(phase === "run"
        ? [
            inline
              ? "Execute the scheduled task in main, using the scheduled workspace."
              : "You run in a separate execution scope, not the main assistant. Execute the scheduled task and make your final response self-contained.",
          ]
        : ["This is a runtime report, not a user request."]),
      `${phase === "run" ? "Assigned scheduled task" : "Scheduled prompt (for reference)"}:\n${prompt.trim()}`,
    ].join("\n\n"),
  };
}

export function buildRuntimeNoticeMessage(notice: RuntimeNotice, timestamp: number): AgentMessage {
  return {
    role: "custom",
    customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:${notice.kind}`,
    content: notice.text,
    details: notice.data,
    timestamp,
  } as AgentMessage;
}
