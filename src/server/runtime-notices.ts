import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";

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
// their application type and full attachment metadata through admission and storage.
// Project it to notice.text only at the model boundary, including native summaries.
export function encodeRuntimeNotice(notice: RuntimeNotice): string {
  return `${NOTICE_OPEN}${JSON.stringify(notice)}${NOTICE_CLOSE}`;
}
export function decodeRuntimeNotice(content: unknown): RuntimeNotice | undefined {
  if (Array.isArray(content)) {
    if (content[0]?.type !== "text" || content.slice(1).some((block) => block?.type !== "image"))
      return undefined;
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

/** Project persisted envelopes, including those embedded in native compaction transcripts.
 * Attachment bodies remain in Durable history for UI display and explicit forwarding.
 */
function modelNoticeText(text: string): string {
  let result = "";
  let offset = 0;
  let start = text.indexOf(NOTICE_OPEN);
  while (start !== -1) {
    let end = text.indexOf(NOTICE_CLOSE, start + NOTICE_OPEN.length);
    let notice: RuntimeNotice | undefined;
    // A report or diff may itself contain the closing marker inside its JSON string.
    while (end !== -1) {
      notice = decodeRuntimeNotice(text.slice(start, end + NOTICE_CLOSE.length));
      if (notice) break;
      end = text.indexOf(NOTICE_CLOSE, end + NOTICE_CLOSE.length);
    }
    if (!notice) {
      start = text.indexOf(NOTICE_OPEN, start + NOTICE_OPEN.length);
      continue;
    }
    result += text.slice(offset, start) + notice.text;
    offset = end + NOTICE_CLOSE.length;
    start = text.indexOf(NOTICE_OPEN, offset);
  }
  return result + text.slice(offset);
}

/** Both generation and completeSimple (native compaction) dispatch through this boundary. */
export function projectRuntimeNoticeRequest(request: Context): Context {
  return {
    ...request,
    messages: request.messages.map((message) => {
      if (message.role !== "user") return message;
      return {
        ...message,
        content:
          typeof message.content === "string"
            ? modelNoticeText(message.content)
            : message.content.map((block) =>
                block.type === "text" ? { ...block, text: modelNoticeText(block.text) } : block,
              ),
      };
    }),
  };
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
  phase = "run",
  now = new Date(),
}: {
  scheduleLabel: string;
  prompt: string;
  phase?: "run" | "delivery" | "skipped";
  now?: Date;
}): RuntimeNotice {
  return {
    kind: "cron",
    text: [
      `Cron ${phase === "run" ? "run triggered" : phase === "delivery" ? "result delivered" : "run skipped"}. Current time: ${now.toISOString()}. Schedule: ${scheduleLabel}.`,
      ...(phase === "run"
        ? [
            "You run in a separate execution scope, not the main assistant. Execute the scheduled task and make your final response self-contained.",
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
