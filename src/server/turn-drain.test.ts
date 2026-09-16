import { describe, expect, it } from "vite-plus/test";
import { TurnDrain } from "./turn-drain";

describe("TurnDrain", () => {
  it("does not increment the active counter for turns rejected during drain", async () => {
    const turns = new TurnDrain();
    turns.beginDrain();

    await expect(turns.run(async () => undefined)).rejects.toMatchObject({ statusCode: 503 });
    expect(turns.activeTurns).toBe(0);
  });

  it("keeps an admitted child turn active across drain without a zero-count gap", async () => {
    const turns = new TurnDrain();
    let releaseChild!: () => void;
    const childDone = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });

    const parent = turns.run(async () => {
      turns.beginDrain();
      return turns.run(async () => childDone, true);
    });

    expect(turns.activeTurns).toBe(2);
    releaseChild();
    await parent;
    expect(turns.activeTurns).toBe(0);
  });
});
