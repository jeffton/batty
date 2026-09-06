import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentSession,
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  getModel,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vite-plus/test";

async function createTurnHarness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-turn-boundary-"));
  const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
  const { session } = await createAgentSession({
    cwd: root,
    model: getModel("anthropic", "claude-sonnet-4-5")!,
    noTools: "all",
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });
  const modelStream = vi.fn(() => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = fauxAssistantMessage("response");
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  });
  session.agent.streamFunction = modelStream;

  return { root, session, sessionManager, modelStream };
}

describe("Pi restart recovery patch", () => {
  it("persists the initial user message and awaits its marker before the model starts", async () => {
    const harness = await createTurnHarness();
    const markerReached = Promise.withResolvers<void>();
    const releaseMarker = Promise.withResolvers<void>();
    try {
      const sessionFile = harness.sessionManager.getSessionFile();
      expect(sessionFile).toBeTruthy();

      const turn = harness.session.prompt("durable request", {
        onTurnStarted: async () => {
          const persisted = await fs.readFile(sessionFile!, "utf8");
          expect(persisted).toContain("durable request");
          markerReached.resolve();
          await releaseMarker.promise;
        },
      });

      await markerReached.promise;
      expect(harness.modelStream).not.toHaveBeenCalled();
      releaseMarker.resolve();
      await turn;
      expect(harness.modelStream).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(harness.root, { recursive: true, force: true });
    }
  });

  it("propagates marker failures without starting the model", async () => {
    const markerError = new Error("journal write failed");
    const harness = await createTurnHarness();
    try {
      await harness.session.prompt("durable request", {
        onTurnStarted: async () => {
          throw markerError;
        },
      });

      expect(harness.modelStream).not.toHaveBeenCalled();
      expect(harness.session.messages.at(-1)).toEqual(
        expect.objectContaining({ role: "assistant", errorMessage: markerError.message }),
      );
    } finally {
      await fs.rm(harness.root, { recursive: true, force: true });
    }
  });

  it("marks a queued interactive user after its unmarked run completes", async () => {
    const harness = await createTurnHarness();
    const markerReached = Promise.withResolvers<void>();
    const releaseMarker = Promise.withResolvers<void>();
    const streams: Array<ReturnType<typeof createAssistantMessageEventStream>> = [];
    harness.session.agent.streamFunction = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      if (streams.length > 0) {
        queueMicrotask(() =>
          stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("response") }),
        );
      }
      streams.push(stream);
      return stream;
    });

    try {
      const initialTurn = harness.session.prompt("cron request");
      await vi.waitFor(() => expect(harness.session.agent.streamFunction).toHaveBeenCalledTimes(1));
      await harness.session.prompt("interactive request", {
        streamingBehavior: "followUp",
        onTurnStarted: async () => {
          markerReached.resolve();
          await releaseMarker.promise;
        },
      });
      streams[0]!.push({ type: "done", reason: "stop", message: fauxAssistantMessage("response") });

      await markerReached.promise;
      expect(harness.session.agent.streamFunction).toHaveBeenCalledTimes(1);
      releaseMarker.resolve();
      await initialTurn;
      expect(harness.session.agent.streamFunction).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(harness.root, { recursive: true, force: true });
    }
  });

  it("does not mark a queued user removed before delivery", async () => {
    const harness = await createTurnHarness();
    const marker = vi.fn();
    const streams: Array<ReturnType<typeof createAssistantMessageEventStream>> = [];
    harness.session.agent.streamFunction = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      streams.push(stream);
      return stream;
    });

    try {
      const initialTurn = harness.session.prompt("cron request");
      await vi.waitFor(() => expect(harness.session.agent.streamFunction).toHaveBeenCalledTimes(1));
      await harness.session.prompt("removed interactive request", {
        streamingBehavior: "followUp",
        onTurnStarted: marker,
      });
      expect(harness.session.removeQueuedPrompt("followUp", 0)).toBe(true);
      streams[0]!.push({ type: "done", reason: "stop", message: fauxAssistantMessage("response") });
      await initialTurn;

      expect(marker).not.toHaveBeenCalled();
    } finally {
      await fs.rm(harness.root, { recursive: true, force: true });
    }
  });

  it("passes a prompt client message ID through to the persisted user message", async () => {
    const runAgentPrompt = vi.fn().mockResolvedValue(undefined);
    const target = {
      _extensionRunner: {
        hasHandlers: vi.fn().mockReturnValue(false),
        emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
      },
      _compactionAbortController: undefined,
      isStreaming: false,
      _flushPendingBashMessages: vi.fn(),
      _flushPendingCustomMessages: vi.fn(),
      model: { provider: "test" },
      _modelRuntime: { hasConfiguredAuth: vi.fn().mockReturnValue(true) },
      _findLastAssistantMessage: vi.fn().mockReturnValue(undefined),
      _pendingNextTurnMessages: [],
      _baseSystemPrompt: "",
      _baseSystemPromptOptions: undefined,
      agent: { state: { systemPrompt: "" } },
      _runAgentPrompt: runAgentPrompt,
    };

    await AgentSession.prototype.prompt.call(target as unknown as AgentSession, "durable request", {
      expandPromptTemplates: false,
      clientMessageId: "prompt-id",
    } as never);

    expect(runAgentPrompt).toHaveBeenCalledWith([
      expect.objectContaining({ role: "user", clientMessageId: "prompt-id" }),
    ]);
  });

  it("continues a persisted interrupted turn without appending another prompt", async () => {
    const continueAgent = vi.fn().mockResolvedValue(undefined);
    const handlePostAgentRun = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const emitSettled = vi.fn().mockResolvedValue(undefined);
    const target = {
      isStreaming: false,
      agent: { continue: continueAgent },
      _isAgentRunActive: false,
      _handlePostAgentRun: handlePostAgentRun,
      _systemPromptOverride: "temporary",
      _flushPendingBashMessages: vi.fn(),
      _flushPendingCustomMessages: vi.fn(),
      _emitAgentSettled: emitSettled,
    };

    await AgentSession.prototype.resumeInterruptedTurn.call(target as unknown as AgentSession);

    expect(continueAgent).toHaveBeenCalledTimes(2);
    expect(emitSettled).toHaveBeenCalledTimes(1);
    expect(target._systemPromptOverride).toBeUndefined();
  });

  it("keeps queue removal without prepared-prompt recovery APIs", async () => {
    const patch = await fs.readFile(
      "patches/@earendil-works__pi-coding-agent@0.85.1.patch",
      "utf8",
    );
    const target = {
      _steeringMessages: ["first", "second"],
      _followUpMessages: [],
      agent: {
        steeringQueue: {
          messages: [
            { role: "user", clientMessageId: "first" },
            { role: "user", clientMessageId: "second" },
          ],
        },
        followUpQueue: { messages: [] },
      },
      _emitQueueUpdate: vi.fn(),
    };

    expect(
      AgentSession.prototype.removeQueuedPrompt.call(target as unknown as AgentSession, "steer", 0),
    ).toBe(true);
    expect(target._steeringMessages).toEqual(["second"]);
    expect(target.agent.steeringQueue.messages).toEqual([
      { role: "user", clientMessageId: "second" },
    ]);
    expect(patch).toContain("resumeInterruptedTurn");
    expect(patch).toContain("removeQueuedPrompt");
    expect(patch).toContain("clientMessageId");
    expect(patch).not.toMatch(/resumeInterruptedPrompt|restoreQueuedPrompt|\.flush\(/);
  });
});
