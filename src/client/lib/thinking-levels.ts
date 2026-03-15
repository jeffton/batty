import type { ModelOption, SessionState } from "@/shared/types";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
export const THINKING_LEVELS_WITH_XHIGH = [...THINKING_LEVELS, "xhigh"] as const;

function sanitizeLevels(levels: string[] | undefined): string[] {
  return Array.isArray(levels)
    ? levels.filter((level) => typeof level === "string" && level.length > 0)
    : [];
}

export function resolveThinkingOptions(
  session: Pick<SessionState, "thinkingLevel" | "availableThinkingLevels" | "model"> | undefined,
  models: Pick<ModelOption, "id" | "reasoning">[],
): string[] {
  if (!session) {
    return [];
  }

  const explicitLevels = sanitizeLevels(session.availableThinkingLevels);
  const currentLevel =
    typeof session.thinkingLevel === "string" && session.thinkingLevel.length > 0
      ? session.thinkingLevel
      : "off";
  const currentModel = models.find((model) => model.id === session.model);

  const looksLikeLegacyFallback =
    explicitLevels.length === 1 &&
    explicitLevels[0] === currentLevel &&
    (currentModel?.reasoning || currentLevel !== "off");

  if (explicitLevels.length > 0 && !looksLikeLegacyFallback) {
    return [...new Set(explicitLevels)];
  }

  if (currentModel && !currentModel.reasoning) {
    return ["off"];
  }

  const baseLevels =
    currentLevel === "xhigh"
      ? THINKING_LEVELS_WITH_XHIGH
      : currentModel?.reasoning || currentLevel !== "off"
        ? THINKING_LEVELS
        : ["off"];

  return [...new Set([...baseLevels, currentLevel].filter(Boolean))];
}
