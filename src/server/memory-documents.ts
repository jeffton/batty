import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { MemoryLeaf } from "./memory-projection";
import type { Part } from "./memory-view";

export const WorkerMemory = defineDoc<{ view: string | null }>({
  kind: "batty.worker-memory",
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
};
export const MemoryMaintenanceDoc = defineDoc<{ generation: number; settled: number }>({
  kind: "batty.memory-maintenance",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ generation: 0, settled: 0 }),
});
export const Rebuild = defineDoc<MemoryRebuild>({
  kind: "batty.memory-rebuild",
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
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (leaf) => leaf,
});
export const MemoryNodesDoc = defineDocFamily<{ text: string }, { text: string }>({
  kind: "batty.memory-node",
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (node) => node,
});
export const Packets = defineDocFamily<
  { view: string; boundary: number },
  { view: string; boundary: number }
>({
  kind: "batty.memory-packet",
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (packet) => packet,
});
