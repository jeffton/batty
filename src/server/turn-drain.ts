export class TurnDrain {
  draining = false;
  activeTurns = 0;

  beginDrain(): void {
    this.draining = true;
  }

  async run<T>(run: () => Promise<T>, admitted = false): Promise<T> {
    if (this.draining && !admitted) {
      throw Object.assign(new Error("Batty is preparing to restart. Try again after restart."), {
        statusCode: 503,
      });
    }
    this.activeTurns += 1;
    try {
      return await run();
    } finally {
      this.activeTurns -= 1;
    }
  }
}
