import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CronJobSession } from "@/shared/types";

export const BATTY_RUNTIME_NOTICE_CUSTOM_TYPE = "batty-runtime-notice";

export type RuntimeNoticeKind = "cron" | "subagent";

export interface RuntimeNotice {
  kind: RuntimeNoticeKind;
  text: string;
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
  session: CronJobSession;
  phase?: "run" | "delivery" | "skipped";
  now?: Date;
}): RuntimeNotice {
  const lines = [
    `Cron ${phase === "run" ? "run triggered" : phase === "delivery" ? "result delivered" : "run skipped"}. Current time: ${formatLocalDateTime(now)}. Schedule: ${scheduleLabel}`,
    "",
    ...(phase === "run"
      ? cronSessionInstructions(session)
      : [
          phase === "delivery"
            ? "Detached cron result. Detailed work stays in the linked session; the final response or error is delivered here."
            : "The following error explains why this scheduled run was skipped.",
        ]),
    "",
    phase === "run" ? "Prompt:" : "Scheduled prompt (for reference):",
    prompt.trim(),
  ];

  return {
    kind: "cron",
    text: lines.join("\n"),
  };
}

function cronSessionInstructions(session: CronJobSession): string[] {
  switch (session.kind) {
    case "new":
      return [
        "Session mode: new. Each run starts fresh with workspace system instructions and the scheduled prompt. Your work and final response stay in this session.",
      ];
    case "daily-inline":
      return [
        "Session mode: daily-inline. You run in the workspace's daily conversation. Your messages, tool calls, and final response remain in its continuing context.",
      ];
    case "daily-detached":
      return [
        "Session mode: daily-detached. Each run gets a separate session alongside the daily conversation.",
        session.includePreviousContext === true
          ? "You have a fixed snapshot of the daily context, copied after pending work settles and possibly compacted."
          : "You start fresh with workspace system instructions and the scheduled prompt.",
        "Detailed work and tool calls stay here; your final response or an error returns to the associated daily session. Make the final response self-contained. Use NO_REPLY for a silent successful run.",
        "This isolation protects daily context. Delegate for useful division of work; manage context usage locally.",
      ];
  }
}

export function buildSubagentRuntimeNotice(depth: number, prompt: string): RuntimeNotice {
  return {
    kind: "subagent",
    text: [
      depth < 2
        ? "Subagent run started. You can delegate to subagents, but subagents you create cannot delegate further."
        : "Subagent run started. Do not call the subagent tool from this session.",
      "",
      "Prompt:",
      prompt.trim(),
    ].join("\n"),
  };
}

export function buildRuntimeNoticeMessage(notice: RuntimeNotice, timestamp: number): AgentMessage {
  return {
    role: "custom",
    customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:${notice.kind}`,
    content: notice.text,
    timestamp,
  } as AgentMessage;
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
