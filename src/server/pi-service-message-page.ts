import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  RECENT_SESSION_MESSAGE_WINDOW,
  SESSION_MESSAGE_PAGE_BYTE_BUDGET,
} from "@/shared/session-history";
import { CRON_RUN_SESSION_CUSTOM_TYPE } from "./cron-session";
import { transcriptMessagesFromSessionEntries } from "./pi-state";

const DEFAULT_MESSAGE_PAGE_SIZE = RECENT_SESSION_MESSAGE_WINDOW;
const MAX_MESSAGE_PAGE_SIZE = 200;

export interface SessionMessagePageOptions {
  beforeMessageId?: string;
  limit?: number;
}

export interface SessionMessagePage {
  messages: AgentSession["messages"];
  totalMessageCount: number;
  hasMoreMessages: boolean;
  messageIndexOffset: number;
}

function clampMessagePageSize(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_MESSAGE_PAGE_SIZE;
  }

  return Math.max(1, Math.min(MAX_MESSAGE_PAGE_SIZE, Math.floor(limit)));
}

function messageIndexFromId(messageId: string | undefined): number | undefined {
  if (!messageId) {
    return undefined;
  }

  const separator = messageId.lastIndexOf("-");
  if (separator === -1) {
    return undefined;
  }

  const index = Number.parseInt(messageId.slice(separator + 1), 10);
  return Number.isFinite(index) && index >= 0 ? index : undefined;
}

function projectedMessageBytes(message: unknown): number {
  const serialized = JSON.stringify(message, function (key, value) {
    return key === "data" && this && (this as { type?: unknown }).type === "image"
      ? undefined
      : value;
  });
  return Buffer.byteLength(serialized ?? "", "utf8");
}

function byteBoundedPageStart(
  messages: AgentSession["messages"],
  start: number,
  end: number,
): number {
  let selectedStart = end;
  let selectedBytes = 0;

  for (let index = end - 1; index >= start; index -= 1) {
    const messageBytes = projectedMessageBytes(messages[index]);
    if (selectedStart < end && selectedBytes + messageBytes > SESSION_MESSAGE_PAGE_BYTE_BUDGET) {
      break;
    }
    selectedStart = index;
    selectedBytes += messageBytes;
  }

  return selectedStart;
}

function transcriptEntriesForPage(
  entries: Array<{ type?: unknown; customType?: unknown }>,
): Array<{ type?: unknown; customType?: unknown }> {
  const cronRunMarkerIndex = entries.findLastIndex(
    (entry) => entry.type === "custom" && entry.customType === CRON_RUN_SESSION_CUSTOM_TYPE,
  );
  return cronRunMarkerIndex >= 0 ? entries.slice(cronRunMarkerIndex + 1) : entries;
}

export function getSessionMessagePage(
  session: AgentSession,
  options?: SessionMessagePageOptions,
): SessionMessagePage {
  const allMessages = transcriptMessagesFromSessionEntries(
    transcriptEntriesForPage(session.sessionManager.getBranch()),
    session.sessionManager.getEntries(),
  );
  const totalMessageCount = allMessages.length;
  const limit = clampMessagePageSize(options?.limit);
  const beforeIndex = messageIndexFromId(options?.beforeMessageId);
  const end =
    typeof beforeIndex === "number" && beforeIndex >= 0
      ? Math.min(beforeIndex, totalMessageCount)
      : totalMessageCount;
  const countBoundedStart = Math.max(0, end - limit);
  const start = byteBoundedPageStart(allMessages, countBoundedStart, end);

  return {
    messages: allMessages.slice(start, end),
    totalMessageCount,
    hasMoreMessages: start > 0,
    messageIndexOffset: start,
  };
}
