import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { MemoryLeaf } from "./memory-projection";
import type { Part } from "./memory-view";

export type MemorySnapshot = { generation: number; count: number; prepared: number };
export type MemoryPacket = { view: string; boundary: number; snapshot: MemorySnapshot };

export const WorkerMemory = defineDoc<{ view: string | null; snapshot?: MemorySnapshot }>({
  kind: "batty.worker-memory",
  checkpointWhen: () => false,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ view: null }),
});

export type MemoryIndex = {
  count: number;
  cursor: number;
  viewCount: number;
  parts: Part[];
  generation?: number;
  merging?: boolean;
};
export type MemoryRebuild = {
  generation: number;
  total: number;
  status: "pending" | "complete";
  level?: number;
  repairs?: string[];
  baseGeneration?: number;
};
export const MemoryMaintenanceDoc = defineDoc<{ generation: number; settled: number }>({
  kind: "batty.memory-maintenance",
  checkpointWhen: () => false,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ generation: 0, settled: 0 }),
});
export const Rebuild = defineDoc<MemoryRebuild>({
  kind: "batty.memory-rebuild",
  checkpointWhen: () => false,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ generation: 0, total: 0, status: "complete" }),
});
export const MemoryIndexDoc = defineDoc<MemoryIndex>({
  kind: "batty.memory-index",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ count: 0, cursor: 0, viewCount: 0, parts: [] }),
  checkpointWhen: (_, __, info) => info.deltasSinceBase >= 31,
});
export const Leaves = defineDocFamily<MemoryLeaf, MemoryLeaf>({
  kind: "batty.memory-leaf",
  checkpointWhen: () => false,
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (leaf) => leaf,
});
export const MemoryNodesDoc = defineDocFamily<{ text: string }, { text: string }>({
  kind: "batty.memory-node",
  checkpointWhen: () => false,
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (node) => node,
});
export const GenerationCounter = defineDoc<{ next: number }>({
  kind: "batty.memory-generation-counter",
  checkpointWhen: () => false,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ next: 1 }),
});

// Repair generations inherit unchanged nodes; published generations remain immutable.
export const Generations = defineDocFamily<
  { parent: number; count: number },
  { parent: number; count: number }
>({
  kind: "batty.memory-generation",
  checkpointWhen: () => false,
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (generation) => generation,
});

// Pinned per input so tool continuations reuse the exact same prompt prefix.
export const MemoryRecall = defineDocFamily<{ text: string }, { text: string }>({
  kind: "batty.memory-recall",
  checkpointWhen: () => false,
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (recall) => recall,
});

export const Packets = defineDocFamily<MemoryPacket, MemoryPacket>({
  kind: "batty.memory-packet",
  checkpointWhen: () => false,
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (packet) => packet,
});
