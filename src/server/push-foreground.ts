import { randomUUID } from "node:crypto";

/** One-shot foreground checks, scoped to a live stream and one push delivery. */
export class PushForeground {
  private readonly clients = new Map<string, { send: (event: string, data: object) => void }>();
  private readonly pending = new Map<
    string,
    { clients: Set<string>; expiresAt: number; finish: (visible: boolean) => void }
  >();

  connect(send: (event: string, data: object) => void): () => void {
    const clientId = randomUUID();
    this.clients.set(clientId, { send });
    send("push-client", { clientId });
    return () => {
      this.clients.delete(clientId);
      for (const pending of this.pending.values()) {
        pending.clients.delete(clientId);
        if (!pending.clients.size) pending.finish(false);
      }
    };
  }

  acknowledge(clientId: string, challengeId: string): boolean {
    const pending = this.pending.get(challengeId);
    if (!pending?.clients.has(clientId) || !this.clients.has(clientId)) return false;
    if (Date.now() >= pending.expiresAt) {
      pending.finish(false);
      return false;
    }
    pending.finish(true);
    return true;
  }

  isVisible(): Promise<boolean> {
    const clients = new Set(this.clients.keys());
    if (!clients.size) return Promise.resolve(false);
    return new Promise((resolve) => {
      const challengeId = randomUUID();
      const finish = (visible: boolean) => {
        clearTimeout(timer);
        this.pending.delete(challengeId);
        resolve(visible);
      };
      const timer = setTimeout(() => finish(false), 1000);
      this.pending.set(challengeId, { clients, expiresAt: Date.now() + 1000, finish });
      for (const clientId of clients) {
        this.clients.get(clientId)!.send("push-foreground", { clientId, challengeId });
      }
    });
  }
}
