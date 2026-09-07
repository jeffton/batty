import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { appendResultDelivery } from "./session-result-delivery";
import { createHarnessFixture } from "./harness-test-fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("durable result delivery", () => {
  it("completes a partial delivery after reopening without duplicating its notice", async () => {
    const fixture = await createHarnessFixture();
    cleanups.push(fixture.cleanup);
    const messages = [
      { role: "user" as const, content: "Detached result", timestamp: 1 },
      fauxAssistantMessage("Done"),
    ];
    const append = fixture.session.lane.appendMessage.bind(fixture.session.lane);
    let count = 0;
    vi.spyOn(fixture.session.lane, "appendMessage").mockImplementation(async (...args) => {
      if (++count === 2) throw new Error("process stopped between delivery entries");
      return append(...args);
    });
    await expect(appendResultDelivery(fixture.session, "run-1", messages)).rejects.toThrow(
      "process stopped",
    );
    expect(fixture.session.messages).toHaveLength(1);
    await fixture.reopen();
    expect(await appendResultDelivery(fixture.session, "run-1", messages)).toBe(true);
    expect(fixture.session.messages).toHaveLength(2);
    await fixture.reopen();
    expect(await appendResultDelivery(fixture.session, "run-1", messages)).toBe(false);
    expect(fixture.session.messages).toHaveLength(2);
    expect(fixture.faux.state.callCount).toBe(0);
  });
});
