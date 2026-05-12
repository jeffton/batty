import type { SessionState, UiContentBlock, UiMessage } from "@/shared/types";

export const NO_REPLY_SENTINEL = "NO_REPLY";

const NOTIFICATION_ICON = "/pwa-192.png";
const MAX_NOTIFICATION_BODY_LENGTH = 180;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeNotificationText(value: string): string {
  return value
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function markdownToNotificationText(value: string): string {
  return normalizeNotificationText(
    value
      .replace(/```(?:[^\n`]*)\n([\s\S]*?)```/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/^[-*+]\s+/gm, "• ")
      .replace(/^(\d+)\.\s+/gm, "$1. ")
      .replace(/^---+$/gm, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/(^|[^*])\*([^*]+)\*(?=[^*]|$)/g, "$1$2")
      .replace(/(^|[^_])_([^_]+)_(?=[^_]|$)/g, "$1$2"),
  );
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
  return normalizeNotificationText(
    blocks
      .filter((block): block is Extract<UiContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => markdownToNotificationText(block.text))
      .filter(Boolean)
      .join("\n\n"),
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

export function assistantNotificationText(
  assistant: Pick<Extract<UiMessage, { role: "assistant" }>, "blocks"> | undefined,
): string {
  return assistant ? textFromBlocks(assistant.blocks) : "";
}

export function suppressAgentCompletionNotification(session: SessionState): boolean {
  if (session.isSubagentSession || session.isCronSession) {
    return true;
  }

  const latestMessage = session.messages.at(-1);
  if (latestMessage?.role !== "assistant") {
    return false;
  }

  return assistantNotificationText(latestMessage) === NO_REPLY_SENTINEL;
}

export { markdownToNotificationText };

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
  const assistantText = assistantNotificationText(assistant);
  const stopReason = assistant?.errorMessage || assistant?.stopReason;
  const body = truncate(assistantText || stopReason || "", MAX_NOTIFICATION_BODY_LENGTH);
  const workspaceLabel = workspaceLabelFromSession(session);

  return {
    title: workspaceLabel,
    body,
    tag: `session-complete:${session.sessionId}`,
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_ICON,
  };
}
