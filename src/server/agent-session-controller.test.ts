import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createAgentSessionFixture } from "./agent-session-test-fixture";

const fixtures: Awaited<ReturnType<typeof createAgentSessionFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});
async function fixture(options?: Parameters<typeof createAgentSessionFixture>[0]) {
  const f = await createAgentSessionFixture(options);
  fixtures.push(f);
  return f;
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function customNoticeEntries(f: Awaited<ReturnType<typeof fixture>>) {
  return f.session.sessionManager
    .getBranch()
    .filter(
      (entry) =>
        entry.type === "custom_message" && entry.customType === "batty-runtime-notice:subagent",
    );
}

async function busyFixture() {
  const started = barrier();
  const finish = barrier();
  const f = await fixture({
    tools: [
      {
        name: "hold",
        label: "hold",
        description: "hold",
        parameters: Type.Object({}),
        async execute(_id, _args, signal) {
          started.release();
          signal?.addEventListener("abort", finish.release, { once: true });
          await finish.promise;
          return { content: [{ type: "text", text: "released" }], details: {} };
        },
      },
    ],
  });
  f.faux.setResponses([
    fauxAssistantMessage([{ type: "toolCall", id: "hold", name: "hold", arguments: {} }]),
    fauxAssistantMessage("answer"),
    fauxAssistantMessage("follow up"),
  ]);
  const run = f.session.prompt("working", { clientMessageId: "initial-client" });
  await started.promise;
  return { f, run, finish };
}

describe("native AgentSession controller", () => {
  it.each(["input", "before_agent_start"] as const)(
    "cancels a blocked %s preflight before model dispatch",
    async (hook) => {
      const entered = barrier();
      const finish = barrier();
      const f = await fixture({
        extensionFactories: [
          (pi) => {
            const block = async () => {
              entered.release();
              await finish.promise;
            };
            if (hook === "input")
              pi.on("input", async () => {
                await block();
                return { action: "continue" };
              });
            else
              pi.on("before_agent_start", async () => {
                await block();
                return undefined;
              });
          },
        ],
      });
      f.faux.setResponses([fauxAssistantMessage("fresh response")]);
      const cancelled = expect(f.session.prompt("cancelled")).rejects.toThrow(/aborted/i);
      await entered.promise;
      await f.session.abort();
      finish.release();
      await cancelled;
      expect(f.faux.state.callCount).toBe(0);
      expect(f.session.messages.some((message) => message.role === "user")).toBe(false);
      await f.session.prompt("fresh prompt");
      expect(f.faux.state.callCount).toBe(1);
    },
  );

  it("cancels blocked authentication before preprompt compaction can change history", async () => {
    const f = await fixture();
    f.faux.setResponses([
      fauxAssistantMessage("first history"),
      fauxAssistantMessage("second history"),
    ]);
    await f.session.prompt("first question");
    await f.session.prompt("second question");
    f.session.settingsManager.applyOverrides({
      compaction: {
        enabled: true,
        reserveTokens: f.session.model!.contextWindow - 1,
        keepRecentTokens: 0,
      },
    });
    const entered = barrier();
    const finish = barrier();
    const checkAuth = f.modelRuntime.checkAuth.bind(f.modelRuntime);
    vi.spyOn(f.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
    vi.spyOn(f.modelRuntime, "checkAuth").mockImplementation(async (...args) => {
      entered.release();
      await finish.promise;
      return checkAuth(...args);
    });
    const cancelled = expect(f.session.prompt("cancelled authentication")).rejects.toThrow(
      /aborted/i,
    );
    await entered.promise;
    await f.session.abort();
    finish.release();
    await cancelled;
    expect(f.faux.state.callCount).toBe(2);
    expect(f.session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(
      false,
    );
    vi.restoreAllMocks();
  });

  it("joins preflight during disposal and rejects admissions waiting behind it", async () => {
    const entered = barrier();
    const finish = barrier();
    const input = vi.fn(async () => {
      entered.release();
      await finish.promise;
      return { action: "continue" as const };
    });
    const f = await fixture({
      extensionFactories: [
        (pi) => {
          pi.on("input", input);
        },
      ],
    });
    const first = expect(f.session.prompt("first")).rejects.toThrow(/aborted/i);
    await entered.promise;
    const second = expect(f.session.prompt("waiting")).rejects.toThrow(/closed/i);
    const closing = f.session.dispose();
    let disposed = false;
    void closing.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    finish.release();
    await Promise.all([first, second, closing]);
    expect(input).toHaveBeenCalledTimes(1);
    expect(f.faux.state.callCount).toBe(0);
    expect(f.session.sdk.isStreaming).toBe(false);
  });
  it("persists user metadata and completed messages in native v3 entries", async () => {
    const f = await fixture();
    f.faux.setResponses([fauxAssistantMessage("answer")]);
    expect(await f.session.prompt("question", { clientMessageId: "client-1" })).toEqual({
      disposition: "completed",
    });
    expect(f.session.messages.find((message) => message.role === "user")).toMatchObject({
      role: "user",
      clientMessageId: "client-1",
    });
    const stored = await fs.readFile(f.session.sessionFile, "utf8");
    expect(JSON.parse(stored.split("\n")[0]!)).toMatchObject({ type: "session", version: 3 });
    expect((await f.reopen()).messages.find((message) => message.role === "user")).toMatchObject({
      clientMessageId: "client-1",
    });
  });

  it.each(["steer", "followUp"] as const)(
    "admits and cancels a native %s prompt while busy",
    async (streamingBehavior) => {
      const { f, run, finish } = await busyFixture();
      try {
        expect(
          await f.session.prompt("queued", { streamingBehavior, clientMessageId: "queued-client" }),
        ).toMatchObject({ disposition: "queued", entryId: expect.any(String) });
        expect(f.session.getQueuedPrompts()).toEqual([
          expect.objectContaining({
            kind: streamingBehavior,
            index: 0,
            text: "queued",
            clientMessageId: "queued-client",
          }),
        ]);
        await f.session.removeQueuedPrompt(streamingBehavior, 0);
        expect(f.session.pendingMessageCount).toBe(0);
      } finally {
        finish.release();
        await run;
      }
      expect(f.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    },
  );

  it("cancels duplicate texts by identity and keeps the remaining image payload", async () => {
    const { f, run, finish } = await busyFixture();
    try {
      await f.session.prompt("same", { streamingBehavior: "steer", clientMessageId: "one" });
      await f.session.prompt("same", {
        streamingBehavior: "steer",
        clientMessageId: "two",
        images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
      });
      await f.session.removeQueuedPrompt("steer", 0);
      expect(f.session.getQueuedPrompts()).toEqual([
        expect.objectContaining({ text: "same", clientMessageId: "two" }),
      ]);
    } finally {
      finish.release();
      await run;
    }
    expect(
      f.session.messages.find(
        (message) =>
          message.role === "user" &&
          "clientMessageId" in message &&
          message.clientMessageId === "two",
      ),
    ).toMatchObject({
      content: expect.arrayContaining([{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }]),
    });
  });

  it("does not persist native SDK queues across reopening", async () => {
    const { f, run, finish } = await busyFixture();
    try {
      await f.session.prompt("volatile queue", {
        streamingBehavior: "followUp",
        clientMessageId: "volatile-client",
      });
      expect(await fs.readFile(f.session.sessionFile, "utf8")).not.toContain("volatile-client");
      await f.session.abort();
    } finally {
      finish.release();
      await run;
    }
    expect((await f.reopen()).pendingMessageCount).toBe(0);
    expect(
      f.session.messages.some(
        (message) => message.role === "user" && JSON.stringify(message).includes("volatile-client"),
      ),
    ).toBe(false);
  });

  it("delivers transcript events after native entries exist", async () => {
    const f = await fixture();
    f.faux.setResponses([fauxAssistantMessage("answer")]);
    const observed: string[] = [];
    f.session.subscribe((event) => {
      if (event.type !== "message_end") return;
      expect(
        f.session.sessionManager
          .getBranch()
          .some((entry) => entry.type === "message" && entry.message.role === event.message.role),
      ).toBe(true);
      observed.push(event.message.role);
    });
    await f.session.prompt("question");
    expect(observed).toEqual(["system", "user", "assistant"]);
  });

  it("delivers a custom parent result at a busy tool boundary", async () => {
    const { f, run, finish } = await busyFixture();
    const onAccepted = vi.fn();
    const delivery = f.session.sendCustomMessage(
      { customType: "batty-runtime-notice:subagent", content: "child result", display: true },
      { triggerTurn: true, steerWhenBusy: true, onAccepted },
    );
    try {
      await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledOnce());
      expect(f.session.sdk.agent.getQueuedMessages("steer")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "custom",
            customType: "batty-runtime-notice:subagent",
          }),
        ]),
      );
    } finally {
      finish.release();
      await run;
      await delivery;
    }
    expect(f.session.pendingMessageCount).toBe(0);
    expect(customNoticeEntries(f)).toHaveLength(1);
  });

  it("delivers an unconsumed child result after aborting the active turn", async () => {
    const { f, run, finish } = await busyFixture();
    const delivery = f.session.sendCustomMessage(
      {
        customType: "batty-runtime-notice:subagent",
        content: "child result",
        display: true,
        details: { subagent: { sessionId: "child" } },
      },
      { triggerTurn: true, steerWhenBusy: true },
    );
    try {
      await vi.waitFor(() =>
        expect(f.session.sdk.agent.getQueuedMessages("steer")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "custom",
              customType: "batty-runtime-notice:subagent",
            }),
          ]),
        ),
      );
      await f.session.abort();
    } finally {
      finish.release();
      await run;
      await delivery;
    }
    expect(customNoticeEntries(f)).toHaveLength(1);
    expect(f.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
    expect(f.session.isStreaming).toBe(false);
  });

  it("queues custom steering without waiting for the active tool", async () => {
    const { f, run, finish } = await busyFixture();
    try {
      await f.session.queueCustomSteeringMessage({
        customType: "batty-runtime-notice:subagent",
        content: "Focus on tests",
        display: true,
      });
      expect(f.session.sdk.agent.getQueuedMessages("steer")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "custom", content: "Focus on tests" }),
        ]),
      );
    } finally {
      finish.release();
      await run;
    }
    expect(
      f.session.sessionManager
        .getBranch()
        .some((entry) => entry.type === "custom_message" && entry.content === "Focus on tests"),
    ).toBe(true);
  });
});
