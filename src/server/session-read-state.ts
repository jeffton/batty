import fs from "node:fs/promises";
import path from "node:path";
import { stateDirPath } from "./options";

interface StoredSessionReadState {
  baselineInitialized: boolean;
  readAtBySessionId: Record<string, number>;
}

export class SessionReadStateStore {
  private readonly filePath: string;
  private readonly readAtBySessionId = new Map<string, number>();
  private baselineInitialized = false;
  private writeQueue = Promise.resolve();

  private constructor(battyDir: string) {
    this.filePath = path.join(stateDirPath(battyDir), "session-read-state.json");
  }

  static async create(battyDir: string): Promise<SessionReadStateStore> {
    const store = new SessionReadStateStore(battyDir);
    try {
      const stored = JSON.parse(await fs.readFile(store.filePath, "utf8")) as
        | StoredSessionReadState
        | Record<string, number>;
      const readAtBySessionId = "readAtBySessionId" in stored ? stored.readAtBySessionId : stored;
      store.baselineInitialized =
        "baselineInitialized" in stored && stored.baselineInitialized === true;
      for (const [sessionId, readAt] of Object.entries(readAtBySessionId)) {
        if (Number.isFinite(readAt)) {
          store.readAtBySessionId.set(sessionId, readAt);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return store;
  }

  async initializeBaseline(
    sessions: Iterable<{ sessionId: string; lastAssistantReplyAt?: number }>,
  ): Promise<void> {
    if (this.baselineInitialized) {
      return;
    }

    for (const session of sessions) {
      if (session.lastAssistantReplyAt != null) {
        this.readAtBySessionId.set(
          session.sessionId,
          Math.max(
            this.readAtBySessionId.get(session.sessionId) ?? 0,
            session.lastAssistantReplyAt,
          ),
        );
      }
    }
    this.baselineInitialized = true;
    await this.persist();
  }

  hasUnread(sessionId: string, lastAssistantReplyAt?: number): boolean {
    return (
      lastAssistantReplyAt != null &&
      lastAssistantReplyAt > (this.readAtBySessionId.get(sessionId) ?? 0)
    );
  }

  async markRead(sessionId: string, readAt = Date.now()): Promise<void> {
    if (readAt <= (this.readAtBySessionId.get(sessionId) ?? 0)) {
      return;
    }

    this.readAtBySessionId.set(sessionId, readAt);
    await this.persist();
  }

  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const stored: StoredSessionReadState = {
        baselineInitialized: this.baselineInitialized,
        readAtBySessionId: Object.fromEntries(this.readAtBySessionId),
      };
      await fs.writeFile(this.filePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    });
    await this.writeQueue;
  }
}
