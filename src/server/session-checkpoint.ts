/** Closing a durable session preserves admitted work; it is not a terminal failure. */
export class SessionCheckpointError extends Error {
  constructor() {
    super("Session checkpointed for restart");
    this.name = "SessionCheckpointError";
  }
}

export function isSessionCheckpointError(error: unknown): boolean {
  return error instanceof SessionCheckpointError;
}
