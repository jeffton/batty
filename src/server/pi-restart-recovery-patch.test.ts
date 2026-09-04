import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

describe("Pi restart recovery patch", () => {
  it("flushes a new session before its first assistant response", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-session-flush-"));
    try {
      const sessionDir = path.join(root, "sessions");
      const manager = SessionManager.create(root, sessionDir);
      manager.appendCustomEntry("batty-test", { active: true });
      const sessionFile = manager.getSessionFile();
      expect(sessionFile).toBeTruthy();
      await expect(fs.access(sessionFile!)).rejects.toThrow();

      manager.flush();

      const persisted = await fs.readFile(sessionFile!, "utf8");
      expect(persisted).toContain('"type":"session"');
      expect(persisted).toContain('"customType":"batty-test"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes queued messages without rebuilding or losing their metadata", () => {
    const first = { role: "user", content: [], clientMessageId: "first" };
    const second = { role: "user", content: [], clientMessageId: "second" };
    const target = {
      _steeringMessages: ["first", "second"],
      _followUpMessages: [],
      agent: {
        steeringQueue: { messages: [first, second] },
        followUpQueue: { messages: [] },
      },
      _emitQueueUpdate: vi.fn(),
    };

    const removed = AgentSession.prototype.removeQueuedPrompt.call(
      target as unknown as AgentSession,
      "steer",
      0,
    );

    expect(removed).toBe(true);
    expect(target._steeringMessages).toEqual(["second"]);
    expect(target.agent.steeringQueue.messages).toEqual([second]);
  });

  it("restores the exact prepared prompt context without rerunning extensions", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "transformed" }] },
      { role: "custom", customType: "context", content: [{ type: "text", text: "extra" }] },
    ];
    const runAgentPrompt = vi.fn().mockResolvedValue(undefined);
    const target = {
      isStreaming: false,
      agent: { state: { systemPrompt: "old" } },
      _systemPromptOverride: undefined,
      _runAgentPrompt: runAgentPrompt,
    };

    await AgentSession.prototype.resumeInterruptedPrompt.call(
      target as unknown as AgentSession,
      "raw",
      { messages: messages as never, systemPrompt: "" },
    );

    expect(runAgentPrompt).toHaveBeenCalledWith(messages);
    expect(target.agent.state.systemPrompt).toBe("");
    expect(target._systemPromptOverride).toBe("");
  });

  it("continues without appending another user prompt and emits settled", async () => {
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
});
