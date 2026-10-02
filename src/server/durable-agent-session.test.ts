import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createAgentSessionFixture } from "./agent-session-test-fixture";
import { DurableAgentSessionController } from "./durable-agent-session";
import { SessionStore } from "./session-store";

const fixtures: Awaited<ReturnType<typeof createAgentSessionFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});
async function setup(options: Parameters<typeof createAgentSessionFixture>[0] = {}) {
  const fixture = await createAgentSessionFixture(options);
  fixtures.push(fixture);
  expect(fixture.session).toBeInstanceOf(DurableAgentSessionController);
  return fixture;
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function holdResponse() {
  return fauxAssistantMessage(
    [{ type: "toolCall", id: "hold-call", name: "hold", arguments: {} }],
    { stopReason: "toolUse" },
  );
}
async function busy() {
  const entered = barrier();
  const finish = barrier();
  const execute = vi.fn(async (_id, _args, signal: AbortSignal | undefined) => {
    entered.release();
    signal?.addEventListener("abort", finish.release, { once: true });
    await finish.promise;
    if (signal?.aborted) throw new Error("Interrupted hold");
    return { content: [{ type: "text" as const, text: "released" }], details: {} };
  });
  const fixture = await setup({
    tools: [
      { name: "hold", label: "Hold", description: "hold", parameters: Type.Object({}), execute },
    ],
  });
  fixture.faux.setResponses([
    holdResponse(),
    fauxAssistantMessage("answer"),
    fauxAssistantMessage("queued answer"),
  ]);
  const run = fixture.session
    .prompt("initial", { clientMessageId: "initial-id" })
    .catch((error: unknown) => error);
  await entered.promise;
  return { fixture, run, finish, execute };
}
function users(fixture: Awaited<ReturnType<typeof setup>>) {
  return fixture.session.messages.filter((message) => message.role === "user");
}

describe("durable runtime admission and recovery", () => {
  it("deduplicates a completed input request across reopening", async () => {
    const fixture = await setup();
    fixture.faux.setResponses([
      fauxAssistantMessage("answer"),
      fauxAssistantMessage("must not run"),
    ]);
    await fixture.session.prompt("question", { clientMessageId: "same-request" });
    await fixture.reopen();
    await fixture.session.prompt("question", { clientMessageId: "same-request" });
    expect(fixture.faux.state.callCount).toBe(1);
    expect(users(fixture)).toHaveLength(1);
    expect(users(fixture)[0]).toMatchObject({ clientMessageId: "same-request" });
  });

  it.each(["steer", "followUp"] as const)(
    "persists and recovers queued %s input without rerunning an unsafe tool",
    async (kind) => {
      const { fixture, execute } = await busy();
      const accepted = await fixture.session.prompt("persisted queue", {
        streamingBehavior: kind,
        clientMessageId: "queue-id",
      });
      expect(accepted).toMatchObject({ disposition: "queued", entryId: expect.any(String) });
      await vi.waitFor(() =>
        expect(fixture.session.getQueuedPrompts()).toEqual([
          expect.objectContaining({ kind, text: "persisted queue", clientMessageId: "queue-id" }),
        ]),
      );
      await fixture.session.dispose();
      fixture.faux.setResponses([
        fauxAssistantMessage("recovered answer"),
        fauxAssistantMessage("queued answer"),
      ]);
      await fixture.reopen();
      await fixture.session.waitForIdle();
      expect(execute).toHaveBeenCalledOnce();
      expect(fixture.session.pendingMessageCount).toBe(0);
      expect(
        users(fixture).filter((message) => JSON.stringify(message).includes("queue-id")),
      ).toHaveLength(1);
      expect(fixture.session.messages).toContainEqual(
        expect.objectContaining({ role: "toolResult", toolName: "hold", isError: true }),
      );
      expect(fixture.session.messages.at(-1)).toMatchObject({ role: "assistant" });
    },
  );

  it("cancels queued inputs by identity rather than duplicate text", async () => {
    const { fixture, run, finish } = await busy();
    try {
      await fixture.session.prompt("same", {
        streamingBehavior: "steer",
        clientMessageId: "cancel-id",
      });
      await fixture.session.prompt("same", {
        streamingBehavior: "steer",
        clientMessageId: "keep-id",
        images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
      });
      await vi.waitFor(() => expect(fixture.session.pendingMessageCount).toBe(2));
      await fixture.session.removeQueuedPrompt("steer", 0);
      await vi.waitFor(() =>
        expect(fixture.session.getQueuedPrompts()).toEqual([
          expect.objectContaining({ text: "same", clientMessageId: "keep-id" }),
        ]),
      );
    } finally {
      finish.release();
      await run;
    }
    expect(users(fixture).some((message) => JSON.stringify(message).includes("cancel-id"))).toBe(
      false,
    );
    expect(
      users(fixture).find((message) => JSON.stringify(message).includes("keep-id")),
    ).toMatchObject({
      content: expect.arrayContaining([{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }]),
    });
    await fixture.reopen();
    expect(fixture.session.pendingMessageCount).toBe(0);
    expect(users(fixture).some((message) => JSON.stringify(message).includes("cancel-id"))).toBe(
      false,
    );
  });

  it("settles once after admitted follow-ups finish", async () => {
    const { fixture, run, finish } = await busy();
    const settled: boolean[] = [];
    fixture.session.subscribe((event) => {
      if (event.type === "agent_settled") settled.push(fixture.session.isStreaming);
    });
    await fixture.session.prompt("follow up", { streamingBehavior: "followUp" });
    finish.release();
    await run;
    expect(settled).toEqual([false]);
    expect(fixture.session.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "queued answer" }],
    });
  });

  it("routes controller configuration and compaction through durable state", async () => {
    const fixture = await setup();
    const model = fixture.session.model!;
    await fixture.session.setModel(model);
    await fixture.session.setThinkingLevel("off");
    // Configuration commits precede the next model request.
    fixture.faux.setResponses([
      fauxAssistantMessage("history ".repeat(100)),
      fauxAssistantMessage("summary"),
    ]);
    await fixture.session.prompt("history");
    expect(await fixture.session.sessionManager.configuration()).toMatchObject({
      model: { provider: model.provider, modelId: model.id },
      thinkingLevel: "off",
    });
    fixture.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 20 } });
    await fixture.session.compact();
    expect(
      fixture.session.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
    ).toBe(true);
  });

  it("joins the committed compaction projection before resolving controller compaction", async () => {
    const fixture = await setup();
    fixture.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 20 } });
    fixture.faux.setResponses([
      fauxAssistantMessage("history ".repeat(100)),
      fauxAssistantMessage("summary"),
    ]);
    await fixture.session.prompt("history");
    const store = fixture.session.sessionManager;
    const observe = store.observeEntries.bind(store);
    const entered = barrier();
    const finish = barrier();
    store.observeEntries = async (entries) => {
      if (entries.some((entry) => entry.kind === "pi.compaction")) {
        entered.release();
        await finish.promise;
      }
      await observe(entries);
    };
    let settled = false;
    const run = fixture.session.compact().then(() => {
      settled = true;
    });
    try {
      await entered.promise;
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      finish.release();
    }
    await run;
    expect(
      fixture.session.sessionManager.getBranch().findLast((entry) => entry.type === "compaction"),
    ).toMatchObject({ summary: expect.stringContaining("summary") });
  });

  it("explicit abort withdraws queued input instead of checkpointing it for recovery", async () => {
    const { fixture, run } = await busy();
    await fixture.session.prompt("withdrawn", {
      streamingBehavior: "followUp",
      clientMessageId: "withdraw-id",
    });
    await fixture.session.abort();
    await run;
    await fixture.reopen();
    await fixture.session.waitForIdle();
    expect(fixture.session.pendingMessageCount).toBe(0);
    expect(users(fixture).some((message) => JSON.stringify(message).includes("withdraw-id"))).toBe(
      false,
    );
    expect(fixture.faux.state.callCount).toBe(1);
  });

  it("recovers interrupted generation after dispose without duplicating admitted input", async () => {
    const fixture = await setup();
    const entered = barrier();
    const finish = barrier();
    fixture.faux.setResponses([
      async (_context, options) => {
        entered.release();
        options?.signal?.addEventListener("abort", finish.release, { once: true });
        await finish.promise;
        return fauxAssistantMessage("interrupted response");
      },
    ]);
    void fixture.session
      .prompt("recover generation", { clientMessageId: "generation-id" })
      .catch(() => {});
    await entered.promise;
    await fixture.session.dispose();
    fixture.faux.setResponses([fauxAssistantMessage("recovered response")]);
    await fixture.reopen();
    await fixture.session.waitForIdle();
    expect(fixture.faux.state.callCount).toBe(2);
    expect(users(fixture)).toHaveLength(1);
    expect(fixture.session.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "recovered response" }],
    });
    expect(
      fixture.session.messages.some((message) =>
        JSON.stringify(message).includes("interrupted response"),
      ),
    ).toBe(false);
  });

  it("delivers finalized output only after its legacy projection is persisted", async () => {
    const fixture = await setup();
    fixture.faux.setResponses([fauxAssistantMessage("persisted answer")]);
    const observed: string[] = [];
    fixture.session.subscribe(async (event) => {
      if (
        event.type !== "message_end" ||
        event.message.role === "system" ||
        !("content" in event.message)
      )
        return;
      const stored = await SessionStore.read(fixture.session.sessionFile);
      expect(stored.entries).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: event.message.role,
            content: event.message.content,
          }),
        }),
      );
      observed.push(event.message.role);
    });
    await fixture.session.prompt("question");
    expect(observed).toContain("user");
    expect(observed).toContain("assistant");
  });
});
