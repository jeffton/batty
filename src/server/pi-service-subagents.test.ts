import { describe, expect, it, vi } from "vite-plus/test";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { runDetachedSubagentSession } from "./pi-service-subagents";

type AgentMessage = AgentSession["messages"][number];

function createAssistantMessage(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

describe("runDetachedSubagentSession", () => {
  it("publishes subagent session details before assistant text starts streaming", async () => {
    const appendedCustomEntries: Array<{ customType: string; data: unknown }> = [];
    const appendedMessages: AgentMessage[] = [];
    const sessionMessages: AgentMessage[] = [];
    const updates: Array<{ content: Array<{ type: "text"; text: string }>; details: any }> = [];

    const subagentSession = {
      sessionId: "subagent-session-1",
      sessionFile: "/tmp/subagent-session-1.jsonl",
      messages: sessionMessages,
      isStreaming: false,
      agent: {
        state: {
          messages: sessionMessages,
        },
      },
      sessionManager: {
        appendCustomEntry(customType: string, data: unknown) {
          appendedCustomEntries.push({ customType, data });
        },
        appendMessage(message: AgentMessage) {
          appendedMessages.push(message);
        },
      },
      subscribe() {
        return () => undefined;
      },
      async prompt() {
        expect(updates).toHaveLength(1);
        sessionMessages.push(createAssistantMessage("Done", 1) as unknown as AgentMessage);
      },
      async abort() {
        return undefined;
      },
    } as unknown as AgentSession;

    const disposeWebSession = vi.fn();
    const queueRuntimeNotice = vi.fn();

    const result = await runDetachedSubagentSession(
      {
        async createPiAgentSession() {
          return { session: subagentSession };
        },
        attachSession(workspace, session) {
          return {
            id: "web-subagent-1",
            workspace,
            session,
            subscribers: new Set(),
            activeTools: new Map(),
            openedAt: 0,
            ephemeral: true,
          };
        },
        queueRuntimeNotice,
        disposeWebSession,
        getSessionMessagesForSubagent() {
          return [];
        },
        workspaceSessionDir: "/tmp",
      },
      {
        workspace: {
          id: "batty",
          label: "Batty",
          path: "/root/github/batty",
          kind: "workspace",
          isPinned: true,
        },
        parentSessionId: "parent-session-1",
        prompt: "Inspect the issue",
        modelId: "openai/gpt-5",
        thinkingLevel: "medium",
        includeSessionContext: true,
        respondIn: "session",
        onUpdate: (partial) => {
          updates.push(partial);
        },
      },
    );

    expect(appendedCustomEntries).toHaveLength(2);
    expect(queueRuntimeNotice).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.content).toEqual([]);
    expect(updates[0]?.details).toMatchObject({
      subagent: {
        prompt: "Inspect the issue",
        model: "openai/gpt-5",
        effort: "medium",
        includeSessionContext: true,
        respondIn: "session",
        workspaceId: "batty",
        sessionId: "subagent-session-1",
        sessionPath: "/tmp/subagent-session-1.jsonl",
      },
    });
    expect(result.details).toMatchObject({
      subagent: {
        sessionId: "subagent-session-1",
        sessionPath: "/tmp/subagent-session-1.jsonl",
      },
    });
    expect(result.text).toBe("Done");
    expect(disposeWebSession).toHaveBeenCalledTimes(1);
    expect(appendedMessages).toEqual([]);
  });
});
