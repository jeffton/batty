import type { ModelOption, SessionState } from "@/shared/types";

function sanitizeLevels(levels: string[] | undefined): string[] {
  return Array.isArray(levels)
    ? levels.filter((level) => typeof level === "string" && level.length > 0)
    : [];
}

export function resolveThinkingOptions(
  session: Pick<SessionState, "availableThinkingLevels"> | undefined,
): string[] {
  if (!session) {
    return [];
  }

  return [...new Set(sanitizeLevels(session.availableThinkingLevels))];
}

export function resolveModelThinkingOptions(
  model: Pick<ModelOption, "thinkingLevels"> | undefined,
): string[] {
  if (!model) {
    return [];
  }

  return [...new Set(sanitizeLevels(model.thinkingLevels))];
}
