import type { ProviderUsageWindow } from "@/shared/types";

export function usageWindowDisplay(window: ProviderUsageWindow, now: number) {
  const remaining = Math.min(100, Math.max(0, 100 - window.usedPercent));
  const resetMs = Math.max(0, window.resetsAt - now);
  const pace = Math.min(1, resetMs / (window.windowSeconds * 1000));
  const hours = window.windowSeconds / 3600;
  const duration = hours >= 24 ? `${hours / 24}d` : `${hours}h`;
  const difference = remaining - pace * 100;
  const deviation = Math.round(Math.abs(difference));
  const paceLabel =
    deviation === 0
      ? "On pace"
      : difference < 0
        ? `${deviation}% in deficit`
        : `${deviation}% surplus`;
  const resetMinutes = Math.floor(resetMs / 60_000);
  const resetHours = Math.floor(resetMinutes / 60);
  const resetDuration =
    resetHours >= 24
      ? `${Math.floor(resetHours / 24)}d ${resetHours % 24}h`
      : `${resetHours}h ${String(resetMinutes % 60).padStart(2, "0")}m`;
  return {
    remaining,
    pace,
    label: `${duration}: ${remaining.toFixed(0)}% remaining`,
    paceLabel,
    resetLabel: `Resets in ${resetDuration}`,
  };
}
