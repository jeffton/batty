import type { ProviderUsageWindow } from "@/shared/types";

export function usageWindowDisplay(window: ProviderUsageWindow, now: number) {
  const remaining = Math.min(100, Math.max(0, 100 - window.usedPercent));
  const pace = Math.min(1, Math.max(0, (window.resetsAt - now) / (window.windowSeconds * 1000)));
  const hours = window.windowSeconds / 3600;
  const duration = hours >= 24 ? `${hours / 24}d` : `${hours}h`;
  return {
    remaining,
    pace,
    label: `${duration}: ${remaining.toFixed(0)}% remaining · resets ${new Date(window.resetsAt).toLocaleString()}`,
  };
}
