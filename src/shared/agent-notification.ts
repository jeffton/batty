import type { SessionState, UiContentBlock, UiMessage } from "@/shared/types";

const NOTIFICATION_ICON = "/pwa-192.png";
const MAX_NOTIFICATION_BODY_LENGTH = 180;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function workspaceLabelFromSession(session: Pick<SessionState, "cwd">): string {
  const segments = session.cwd.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? session.cwd;
}

function textFromBlocks(blocks: UiContentBlock[]): string {
  return normalizeWhitespace(
    blocks
      .filter((block): block is Extract<UiContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
  );
}

export function latestAssistantMessage(
  session: SessionState,
): Extract<UiMessage, { role: "assistant" }> | undefined {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message?.role === "assistant") {
      return message;
    }
  }

  return undefined;
}

export interface AgentCompletionNotificationContent {
  title: string;
  body: string;
  tag: string;
  icon: string;
  badge: string;
}

export function buildAgentCompletionNotificationContent(
  session: SessionState,
): AgentCompletionNotificationContent {
  const assistant = latestAssistantMessage(session);
  const assistantText = assistant ? textFromBlocks(assistant.blocks) : "";
  const stopReason = assistant?.errorMessage || assistant?.stopReason;
  const body = truncate(
    assistantText || stopReason || "Pi finished responding.",
    MAX_NOTIFICATION_BODY_LENGTH,
  );
  const workspaceLabel = workspaceLabelFromSession(session);

  return {
    title: workspaceLabel,
    body,
    tag: `session-complete:${session.sessionId}`,
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_ICON,
  };
}
