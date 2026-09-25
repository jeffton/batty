import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { appendResultMessages } from "./session-result-delivery";
import { createHarnessFixture } from "./harness-test-fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("result delivery", () => {
  it("appends each message after the parent becomes idle without delivery metadata", async () => {
    const fixture = await createHarnessFixture();
    cleanups.push(fixture.cleanup);
    const messages = [
      { role: "user" as const, content: "Detached result", timestamp: 1 },
      fauxAssistantMessage("Done"),
    ];
    await appendResultMessages(fixture.session, messages);
    expect(fixture.session.messages).toEqual(messages);
    await fixture.reopen();
    expect(fixture.session.messages).toEqual(messages);
    expect(fixture.faux.state.callCount).toBe(0);
  });
});
