import fs from "node:fs/promises";
import path from "node:path";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  generateUnifiedPatch,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { AgentTurnFileChange } from "@/shared/types";

export const AGENT_TURN_FILE_CHANGES_CUSTOM_TYPE = "batty-agent-turn-file-changes";

interface TrackedFileChange {
  path: string;
  before: string | null;
  after: string;
}

interface FileChangeAccumulator {
  files: Map<string, TrackedFileChange>;
}

interface PersistedAgentTurnFileChanges {
  version: 1;
  replyEntryId: string;
  files: AgentTurnFileChange[];
}

function createAccumulator(): FileChangeAccumulator {
  return { files: new Map() };
}

async function canonicalFilePath(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return path.resolve(filePath);
    }
    throw error;
  }
}

async function readTextFile(filePath: string): Promise<string | null | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return undefined;
  }
}

function recordFileChange(
  accumulator: FileChangeAccumulator,
  filePath: string,
  before: string | null,
  after: string,
): void {
  const existing = accumulator.files.get(filePath);
  accumulator.files.set(filePath, {
    path: filePath,
    before: existing ? existing.before : before,
    after,
  });
}

function completedChanges(accumulator: FileChangeAccumulator): AgentTurnFileChange[] {
  return [...accumulator.files.values()]
    .filter((file) => file.before !== file.after)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({
      path: file.path,
      patch: generateUnifiedPatch(file.path, file.before ?? "", file.after),
    }));
}

function isAgentTurnFileChange(value: unknown): value is AgentTurnFileChange {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.path === "string" && typeof candidate.patch === "string";
}

function persistedFileChanges(value: unknown): PersistedAgentTurnFileChanges | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.replyEntryId !== "string" ||
    !Array.isArray(candidate.files) ||
    !candidate.files.every(isAgentTurnFileChange)
  ) {
    return undefined;
  }
  return candidate as unknown as PersistedAgentTurnFileChanges;
}

export function agentTurnFileChangesByReplyEntryId(
  entries: Array<{
    type?: unknown;
    customType?: unknown;
    data?: unknown;
  }>,
): Map<string, AgentTurnFileChange[]> {
  const result = new Map<string, AgentTurnFileChange[]>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== AGENT_TURN_FILE_CHANGES_CUSTOM_TYPE) {
      continue;
    }
    const persisted = persistedFileChanges(entry.data);
    if (persisted) {
      result.set(persisted.replyEntryId, persisted.files);
    }
  }
  return result;
}

function latestAssistantEntryId(
  entries: Array<{ type?: unknown; id?: unknown; message?: { role?: unknown } }>,
): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      return typeof entry.id === "string" ? entry.id : undefined;
    }
  }
  return undefined;
}

export class AgentTurnFileChangeTracker {
  private local: FileChangeAccumulator;
  private readonly aggregate: FileChangeAccumulator;
  private readonly isRoot: boolean;
  private active = false;

  constructor(aggregate?: FileChangeAccumulator) {
    this.isRoot = aggregate === undefined;
    this.aggregate = aggregate ?? createAccumulator();
    this.local = this.isRoot ? this.aggregate : createAccumulator();
  }

  aggregateForChild(): FileChangeAccumulator | undefined {
    return this.active ? this.aggregate : undefined;
  }

  private start(): void {
    if (this.active) {
      return;
    }
    if (this.isRoot) {
      this.aggregate.files.clear();
      this.local = this.aggregate;
    } else {
      this.local = createAccumulator();
    }
    this.active = true;
  }

  private record(filePath: string, before: string | null, after: string): void {
    if (!this.active) {
      return;
    }
    recordFileChange(this.local, filePath, before, after);
    if (this.aggregate !== this.local) {
      recordFileChange(this.aggregate, filePath, before, after);
    }
  }

  private finish(): AgentTurnFileChange[] {
    if (!this.active) {
      return [];
    }
    this.active = false;
    return completedChanges(this.isRoot ? this.aggregate : this.local);
  }

  createExtension(cwd: string): InlineExtension {
    return {
      name: "batty-agent-turn-file-changes",
      hidden: true,
      factory: (pi) => {
        const trackedWrite = async (absolutePath: string, content: string): Promise<void> => {
          const before = await readTextFile(absolutePath);
          await fs.writeFile(absolutePath, content);
          if (before !== undefined) {
            this.record(await canonicalFilePath(absolutePath), before, content);
          }
        };

        const writeTool = createWriteToolDefinition(cwd, {
          operations: {
            mkdir: (directory) => fs.mkdir(directory, { recursive: true }).then(() => undefined),
            writeFile: trackedWrite,
          },
        });
        const editTool = createEditToolDefinition(cwd, {
          operations: {
            access: (filePath) => fs.access(filePath, fs.constants.R_OK | fs.constants.W_OK),
            readFile: (filePath) => fs.readFile(filePath),
            writeFile: trackedWrite,
          },
        });

        pi.registerTool(writeTool);
        pi.registerTool(editTool);
        pi.on("agent_start", () => {
          this.start();
        });
        pi.on("agent_end", (_event, ctx) => {
          const files = this.finish();
          if (files.length === 0) {
            return;
          }
          const replyEntryId = latestAssistantEntryId(ctx.sessionManager.getBranch());
          if (!replyEntryId) {
            return;
          }
          pi.appendEntry(AGENT_TURN_FILE_CHANGES_CUSTOM_TYPE, {
            version: 1,
            replyEntryId,
            files,
          } satisfies PersistedAgentTurnFileChanges);
        });
      },
    };
  }
}
