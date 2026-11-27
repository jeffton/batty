import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface MaintenanceModel {
  provider: string;
  modelId: string;
  thinkingLevel: ModelThinkingLevel;
}

export interface MaintenanceJob {
  unit: string;
  invocationId: string;
}

export interface MaintenanceState {
  id: string;
  phase: "offline" | "starting";
  task?: string;
  context?: string;
  job?: MaintenanceJob;
  message: string;
  progress: number | null;
  startedAt: number;
  updatedAt: number;
  model: MaintenanceModel;
}

export const maintenanceDir = (root: string) => path.join(root, "maintenance");
export const maintenanceFile = (root: string) => path.join(maintenanceDir(root), "active.json");

export async function readMaintenance(root: string): Promise<MaintenanceState | undefined> {
  try {
    return JSON.parse(await fs.readFile(maintenanceFile(root), "utf8")) as MaintenanceState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function writeMaintenance(root: string, state: MaintenanceState): Promise<void> {
  const target = maintenanceFile(root);
  const temporary = `${target}.${randomUUID()}`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600, flush: true });
    await fs.rename(temporary, target);
    await flushDirectory(root);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function clearMaintenance(root: string): Promise<void> {
  await fs.unlink(maintenanceFile(root));
  await flushDirectory(root);
}

async function flushDirectory(root: string): Promise<void> {
  const directory = await fs.open(maintenanceDir(root), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export function mainLoopback(port: number, host = "127.0.0.1"): string {
  if (host === "::" || host === "::1") return `http://[::1]:${port}`;
  if (host === "0.0.0.0" || host === "127.0.0.1" || host === "localhost")
    return `http://127.0.0.1:${port}`;
  throw new Error("Maintenance requires Batty to listen on loopback");
}
