import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stateDirPath } from "./options";

export const ACTIVE_INTERACTIVE_TURN_FILE_NAME = "active-interactive-turns.json";

export interface ActiveInteractiveTurn {
  workspaceId: string;
  sessionId: string;
  sessionPath: string;
}

export class ActiveInteractiveTurnJournal {
  private readonly filePath: string;
  private entries: Map<string, ActiveInteractiveTurn>;
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(battyDir: string, entries: Map<string, ActiveInteractiveTurn>) {
    this.filePath = path.join(stateDirPath(battyDir), ACTIVE_INTERACTIVE_TURN_FILE_NAME);
    this.entries = entries;
  }

  static async create(battyDir: string): Promise<ActiveInteractiveTurnJournal> {
    const filePath = path.join(stateDirPath(battyDir), ACTIVE_INTERACTIVE_TURN_FILE_NAME);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new ActiveInteractiveTurnJournal(battyDir, new Map());
      }
      throw error;
    }

    const stored = JSON.parse(content) as Record<string, ActiveInteractiveTurn>;
    return new ActiveInteractiveTurnJournal(battyDir, new Map(Object.entries(stored)));
  }

  list(): ActiveInteractiveTurn[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  async set(entry: ActiveInteractiveTurn): Promise<void> {
    await this.mutate(() => {
      const entries = new Map(this.entries);
      entries.set(entry.sessionId, { ...entry });
      return entries;
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.mutate(() => {
      if (!this.entries.has(sessionId)) return;
      const entries = new Map(this.entries);
      entries.delete(sessionId);
      return entries;
    });
  }

  private async mutate(
    operation: () => Map<string, ActiveInteractiveTurn> | undefined,
  ): Promise<void> {
    const mutation = this.mutationQueue.then(async () => {
      const entries = operation();
      if (!entries) return;
      await this.persist(entries);
      this.entries = entries;
    });
    this.mutationQueue = mutation.then(
      () => undefined,
      () => undefined,
    );
    await mutation;
  }

  private async persist(entries: Map<string, ActiveInteractiveTurn>): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${randomUUID()}.tmp`,
    );
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(
        temporaryPath,
        `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`,
        "utf8",
      );
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
