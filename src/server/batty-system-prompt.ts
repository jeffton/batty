import type { WorkspaceInfo } from "@/shared/types";

export const BATTY_SYSTEM_PROMPT_CUSTOM_TYPE = "batty-system-prompt";

export interface BattySystemPromptSnapshot {
  appendedPrompt: string;
  workspaceId: string;
  workspacePath: string;
  model: string;
  thinkingLevel: string;
  date: string;
  isoWeek: number;
  dailySessionDate?: string;
}

export function buildBattySystemPromptSnapshot(
  workspace: Pick<WorkspaceInfo, "id" | "path">,
  model: string,
  thinkingLevel: string,
  now = new Date(),
  battyReadmePath?: string,
  dailySessionDate?: string,
): BattySystemPromptSnapshot {
  const date = toIsoDate(now);
  const dayOfWeek = getDayOfWeek(now);
  const isoWeek = getIsoWeekNumber(now);

  return {
    appendedPrompt: [
      "## Batty session context",
      "Short note: you are running inside Batty.",
      "If your final reply would not add anything useful for the user, reply with exactly NO_REPLY. Batty will still display that in the transcript, but it will not send a push notification for it.",
      ...(battyReadmePath ? [`Batty README: ${battyReadmePath}`] : []),
      `Current workspace: ${workspace.id} (${workspace.path})`,
      ...(dailySessionDate === date
        ? [`Current session: today's daily session for workspace ${workspace.id}`]
        : []),
      `Current model: ${model}`,
      `Current thinking level: ${thinkingLevel}`,
      `Current date: ${date} (${dayOfWeek}, ISO week ${isoWeek})`,
    ].join("\n"),
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    model,
    thinkingLevel,
    date,
    isoWeek,
    ...(dailySessionDate ? { dailySessionDate } : {}),
  };
}

export function findBattySystemPromptSnapshot(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
): BattySystemPromptSnapshot | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== BATTY_SYSTEM_PROMPT_CUSTOM_TYPE) {
      continue;
    }
    if (isBattySystemPromptSnapshot(entry.data)) {
      return entry.data;
    }
  }
  return undefined;
}

function isBattySystemPromptSnapshot(value: unknown): value is BattySystemPromptSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const snapshot = value as Partial<BattySystemPromptSnapshot>;
  return (
    typeof snapshot.appendedPrompt === "string" &&
    typeof snapshot.workspaceId === "string" &&
    typeof snapshot.workspacePath === "string" &&
    typeof snapshot.model === "string" &&
    typeof snapshot.thinkingLevel === "string" &&
    typeof snapshot.date === "string" &&
    typeof snapshot.isoWeek === "number" &&
    (snapshot.dailySessionDate === undefined || typeof snapshot.dailySessionDate === "string")
  );
}

function toIsoDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getDayOfWeek(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
  }).format(date);
}

function getIsoWeekNumber(date: Date): number {
  const localDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = localDate.getDay() || 7;
  localDate.setDate(localDate.getDate() + 4 - day);
  const yearStart = new Date(localDate.getFullYear(), 0, 1);
  return Math.ceil(((localDate.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
