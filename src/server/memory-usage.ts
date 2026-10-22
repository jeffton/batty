import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { defineDoc } from "@earendil-works/pi-durable";

export type MemoryOperation = "incremental" | "rebuild";
export type MemoryCall = {
  operation: MemoryOperation;
  generation: number;
  start: number;
  count: number;
  sourceHash: string;
  attempt: number;
  provider: string;
  model: string;
  startedAt: number;
  finishedAt: number;
  stopReason: AssistantMessage["stopReason"] | "thrown";
  responseId?: string;
  usage?: Usage;
};
type Totals = {
  attempts: number;
  measured: number;
  unmeasured: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  totalTokens: number;
  apiEquivalentCost: number;
};
export const emptyMemoryUsage = (): Totals => ({
  attempts: 0,
  measured: 0,
  unmeasured: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  totalTokens: 0,
  apiEquivalentCost: 0,
});
export const MemoryUsageDoc = defineDoc<{
  incremental: Totals;
  rebuild: Totals;
  since: number | null;
}>({
  kind: "batty.memory-usage",
  checkpointWhen: () => false,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ incremental: emptyMemoryUsage(), rebuild: emptyMemoryUsage(), since: null }),
});

export function accountMemoryCall(totals: Totals, call: MemoryCall) {
  totals.attempts++;
  // Providers use all-zero usage for failures with no returned token accounting.
  if (!call.usage || call.usage.totalTokens === 0) {
    totals.unmeasured++;
    return;
  }
  totals.measured++;
  for (const field of [
    "input",
    "cacheRead",
    "cacheWrite",
    "output",
    "reasoning",
    "totalTokens",
  ] as const)
    totals[field] += call.usage[field] ?? 0;
  // Reasoning is already included in output. Catalog cost is not subscription spending.
  totals.apiEquivalentCost += call.usage.cost.total;
}
