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
  it("persists durable delivery receipts across reopen", async () => {
    const fixture = await createAgentSessionFixture();
    cleanups.push(fixture.cleanup);
    const messages = [fauxAssistantMessage("Positive result")];
    expect(await appendResultMessages(fixture.session, messages, "cron:new-run")).toBe(true);
    await fixture.reopen();
    expect(await appendResultMessages(fixture.session, messages, "cron:new-run")).toBe(false);
    expect(fixture.session.messages).toHaveLength(1);
    expect(fixture.faux.state.callCount).toBe(0);
  });
  it("commits messages and receipt atomically when storage fails", async () => {
    const fixture = await createAgentSessionFixture();
    cleanups.push(fixture.cleanup);
    const store = fixture.session.sessionManager;
    vi.spyOn(store.storage, "commit").mockRejectedValueOnce(new Error("storage failure"));
    await expect(
      appendResultMessages(
        fixture.session,
        [fauxAssistantMessage("Not persisted")],
        "atomic:failure",
      ),
    ).rejects.toThrow("storage failure");
    await fixture.reopen();
    expect(fixture.session.messages).toHaveLength(0);
    expect(
      fixture.session.sessionManager
        .getEntries()
        .some((entry) => entry.type === "custom" && entry.customType === "batty-result-delivery"),
    ).toBe(false);
    expect(
      await appendResultMessages(
        fixture.session,
        [fauxAssistantMessage("Retry")],
        "atomic:failure",
      ),
    ).toBe(true);
  });
  it("serializes concurrent duplicate deliveries into one atomic result", async () => {
    const fixture = await createAgentSessionFixture();
    cleanups.push(fixture.cleanup);
    const messages = [fauxAssistantMessage("One result")];
    const results = await Promise.all([
      appendResultMessages(fixture.session, messages, "atomic:concurrent"),
      appendResultMessages(fixture.session, messages, "atomic:concurrent"),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(fixture.session.messages).toHaveLength(1);
    expect(
      fixture.session.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "batty-result-delivery"),
    ).toHaveLength(1);
  });
  it("appends each message after the parent becomes idle without delivery metadata", async () => {
    const fixture = await createAgentSessionFixture();
    cleanups.push(fixture.cleanup);
    const messages = [
      { role: "user" as const, content: "Detached result", timestamp: 1 },
      fauxAssistantMessage("Done"),
    ];
    const commit = vi.spyOn(fixture.session.sessionManager.conversation, "commit");
    await appendResultMessages(fixture.session, messages);
    expect(commit).toHaveBeenCalledOnce();
    expect(fixture.session.messages).toMatchObject(messages);
    await fixture.reopen();
    expect(fixture.session.messages).toMatchObject(messages);
    expect(fixture.faux.state.callCount).toBe(0);
  });
});
