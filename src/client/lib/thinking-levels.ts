import type { ModelOption } from "@/shared/types";

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
