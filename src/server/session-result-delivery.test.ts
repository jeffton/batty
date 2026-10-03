import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { appendResultMessages } from "./session-result-delivery";
import { createAgentSessionFixture } from "./agent-session-test-fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("result delivery", () => {
  it("persists native delivery receipts across reopen", async () => {
    const fixture = await createAgentSessionFixture();
    cleanups.push(fixture.cleanup);
    const messages = [fauxAssistantMessage("Positive result")];
    expect(await appendResultMessages(fixture.session, messages, "cron:new-run")).toBe(true);
    await fixture.reopen();
    expect(await appendResultMessages(fixture.session, messages, "cron:new-run")).toBe(false);
    expect(fixture.session.messages).toHaveLength(1);
    expect(fixture.faux.state.callCount).toBe(0);
  });
  it("waits once and rechecks delivery deduplication after becoming idle", async () => {
    const fixture = await createAgentSessionFixture();
    cleanups.push(fixture.cleanup);
    let release!: () => void;
    const idle = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wait = vi.spyOn(fixture.session, "waitForIdle").mockReturnValue(idle);
    const append = vi.spyOn(fixture.session.sessionManager, "appendMessage");
    const delivery = appendResultMessages(
      fixture.session,
      [fauxAssistantMessage("Positive result")],
      "subagent:child:reply",
    );
    expect(wait).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
    await fixture.session.sessionManager.appendCustomEntry("batty-result-delivery", {
      replyId: "subagent:child:reply",
    });
    release();
    expect(await delivery).toBe(false);
    expect(append).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledOnce();
  });

  it("appends each message after the parent becomes idle without delivery metadata", async () => {
    const fixture = await createAgentSessionFixture();
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
