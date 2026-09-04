import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stateDirPath } from "./options";

export const ACTIVE_INTERACTIVE_TURN_JOURNAL_VERSION = 1 as const;
export const ACTIVE_INTERACTIVE_TURN_JOURNAL_FILE_NAME = "active-interactive-turn-journal.json";

export interface PreparedSubmissionImage {
  type: "image";
  mimeType: string;
  data: string;
}

export interface PreparedInteractiveTurnSubmission {
  text: string;
  images: PreparedSubmissionImage[];
  clientMessageId: string;
  streamingBehavior?: "steer" | "followUp";
  messages?: unknown[];
  systemPrompt?: string;
}

export interface ActiveInteractiveTurnJournalEntry {
  workspaceId: string;
  sessionId: string;
  sessionPath: string;
  submissions: PreparedInteractiveTurnSubmission[];
  startedAtMs: number;
}

export type InitialActiveInteractiveTurnJournalEntry = ActiveInteractiveTurnJournalEntry;

interface StoredJournal {
  version: typeof ACTIVE_INTERACTIVE_TURN_JOURNAL_VERSION;
  entries: Record<string, ActiveInteractiveTurnJournalEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(filePath: string, detail: string): Error {
  return new Error(`Invalid active interactive-turn journal in ${filePath}: ${detail}`);
}

function stringField(value: unknown, name: string, filePath: string): string {
  if (typeof value !== "string") {
    throw invalid(filePath, `${name} must be a string`);
  }
  return value;
}

function parseSubmission(value: unknown, filePath: string): PreparedInteractiveTurnSubmission {
  if (!isRecord(value)) throw invalid(filePath, "submission must be an object");
  if (!Array.isArray(value.images)) throw invalid(filePath, "submission images must be an array");
  const images = value.images.map((image) => {
    if (!isRecord(image) || image.type !== "image") {
      throw invalid(filePath, "submission images must be image objects");
    }
    return {
      type: "image" as const,
      mimeType: stringField(image.mimeType, "image mimeType", filePath),
      data: stringField(image.data, "image data", filePath),
    };
  });
  if (value.messages !== undefined && !Array.isArray(value.messages)) {
    throw invalid(filePath, "submission messages must be an array");
  }
  if (value.systemPrompt !== undefined && typeof value.systemPrompt !== "string") {
    throw invalid(filePath, "submission systemPrompt must be a string");
  }
  if (
    value.streamingBehavior !== undefined &&
    value.streamingBehavior !== "steer" &&
    value.streamingBehavior !== "followUp"
  ) {
    throw invalid(filePath, "streamingBehavior must be steer or followUp");
  }
  return {
    text: stringField(value.text, "submission text", filePath),
    images,
    clientMessageId: stringField(value.clientMessageId, "clientMessageId", filePath),
    ...(value.streamingBehavior !== undefined
      ? { streamingBehavior: value.streamingBehavior as "steer" | "followUp" }
      : {}),
    ...(value.messages !== undefined ? { messages: structuredClone(value.messages) } : {}),
    ...(value.systemPrompt !== undefined ? { systemPrompt: value.systemPrompt } : {}),
  };
}

function parseEntry(
  value: unknown,
  sessionId: string,
  filePath: string,
): ActiveInteractiveTurnJournalEntry {
  if (!isRecord(value)) throw invalid(filePath, `entry ${sessionId} must be an object`);
  if (!Array.isArray(value.submissions) || value.submissions.length === 0) {
    throw invalid(filePath, `entry ${sessionId} submissions must be a non-empty array`);
  }
  if (typeof value.startedAtMs !== "number" || !Number.isFinite(value.startedAtMs)) {
    throw invalid(filePath, `entry ${sessionId} startedAtMs must be a finite number`);
  }
  return {
    workspaceId: stringField(value.workspaceId, `entry ${sessionId} workspaceId`, filePath),
    sessionId: stringField(value.sessionId, `entry ${sessionId} sessionId`, filePath),
    sessionPath: stringField(value.sessionPath, `entry ${sessionId} sessionPath`, filePath),
    submissions: value.submissions.map((submission) => parseSubmission(submission, filePath)),
    startedAtMs: value.startedAtMs,
  };
}

function cloneEntry(entry: ActiveInteractiveTurnJournalEntry): ActiveInteractiveTurnJournalEntry {
  return {
    ...entry,
    submissions: entry.submissions.map((submission) => structuredClone(submission)),
  };
}

export class ActiveInteractiveTurnJournal {
  private readonly filePath: string;
  private readonly entries = new Map<string, ActiveInteractiveTurnJournalEntry>();
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(battyDir: string) {
    this.filePath = path.join(stateDirPath(battyDir), ACTIVE_INTERACTIVE_TURN_JOURNAL_FILE_NAME);
  }

  static async create(battyDir: string): Promise<ActiveInteractiveTurnJournal> {
    const journal = new ActiveInteractiveTurnJournal(battyDir);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(journal.filePath, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return journal;
      throw error;
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== ACTIVE_INTERACTIVE_TURN_JOURNAL_VERSION ||
      !isRecord(parsed.entries)
    ) {
      throw invalid(journal.filePath, "expected version 1 with an entries object");
    }
    for (const [sessionId, value] of Object.entries(parsed.entries)) {
      const entry = parseEntry(value, sessionId, journal.filePath);
      if (entry.sessionId !== sessionId)
        throw invalid(journal.filePath, `entry key ${sessionId} does not match sessionId`);
      journal.entries.set(sessionId, entry);
    }
    return journal;
  }

  list(): ActiveInteractiveTurnJournalEntry[] {
    return [...this.entries.values()].map(cloneEntry);
  }

  get(sessionId: string): ActiveInteractiveTurnJournalEntry | undefined {
    const entry = this.entries.get(sessionId);
    return entry ? cloneEntry(entry) : undefined;
  }

  async upsertInitialEntry(entry: InitialActiveInteractiveTurnJournalEntry): Promise<void> {
    await this.mutate(() => {
      if (entry.submissions.length === 0) {
        throw new Error("An active interactive turn must contain an initial submission");
      }
      this.entries.set(entry.sessionId, cloneEntry(entry));
    });
  }

  async appendQueuedSubmission(
    sessionId: string,
    submission: PreparedInteractiveTurnSubmission,
  ): Promise<void> {
    await this.mutate(() => {
      const entry = this.requireEntry(sessionId);
      entry.submissions.push(parseSubmission(submission, this.filePath));
    });
  }

  async removeSubmission(sessionId: string, clientMessageId: string): Promise<void> {
    await this.mutate(() => {
      const entry = this.requireEntry(sessionId);
      const index = entry.submissions.findIndex(
        (submission) => submission.clientMessageId === clientMessageId,
      );
      if (index >= 0) entry.submissions.splice(index, 1);
      if (entry.submissions.length === 0) this.entries.delete(sessionId);
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.mutate(() => {
      this.entries.delete(sessionId);
    });
  }

  private requireEntry(sessionId: string): ActiveInteractiveTurnJournalEntry {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error(`No active interactive turn for session ${sessionId}`);
    return entry;
  }

  private async mutate<T>(operation: () => T): Promise<T> {
    const result = this.mutationQueue.then(async () => {
      const value = operation();
      await this.persist();
      return value;
    });
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persist(): Promise<void> {
    const stored: StoredJournal = {
      version: ACTIVE_INTERACTIVE_TURN_JOURNAL_VERSION,
      entries: Object.fromEntries([...this.entries].map(([id, entry]) => [id, cloneEntry(entry)])),
    };
    const directory = path.dirname(this.filePath);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${randomUUID()}.tmp`,
    );
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
