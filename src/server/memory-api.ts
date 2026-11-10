import type { createMemory } from "./memory";

export interface MemoryRepairInput {
  roots: { start: number; count: number }[];
  generation: number;
  dryRun: boolean;
}

/** A repair is destructive unless explicitly requested as a dry run. Validate before dispatch. */
export function repairMemory(
  memory: Pick<ReturnType<typeof createMemory>, "repair">,
  input: MemoryRepairInput,
) {
  const { roots, generation, dryRun } = input;
  if (
    !Number.isInteger(generation) ||
    generation < 0 ||
    typeof dryRun !== "boolean" ||
    !Array.isArray(roots) ||
    !roots.length ||
    roots.some(
      (root) =>
        !root ||
        !Number.isInteger(root.start) ||
        root.start < 0 ||
        !Number.isInteger(root.count) ||
        root.count < 1,
    )
  )
    throw Object.assign(new Error("Invalid memory repair request"), { statusCode: 400 });
  return memory.repair(roots, generation, dryRun);
}
