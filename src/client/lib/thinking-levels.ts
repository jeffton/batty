import type { ModelOption, SessionState } from "@/shared/types";

export function resolveThinkingOptions(
  session: Pick<SessionState, "availableThinkingLevels"> | undefined,
): string[] {
  return [...new Set(session?.availableThinkingLevels)];
}

export function resolveModelThinkingOptions(
  model: Pick<ModelOption, "thinkingLevels"> | undefined,
): string[] {
  return [...new Set(model?.thinkingLevels)];
}

export function normalizeModelThinkingLevel(
  model: Pick<ModelOption, "thinkingLevels"> | undefined,
  thinkingLevel: string | undefined,
): string {
  const options = resolveModelThinkingOptions(model);
  return thinkingLevel && options.includes(thinkingLevel) ? thinkingLevel : (options[0] ?? "off");
}
