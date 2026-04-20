import { describe, expect, it, vi } from "vite-plus/test";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { appendCronSubagentCompletion, runDetachedSubagentSession } from "./pi-service-subagents";
import { BATTY_RUNTIME_NOTICE_CUSTOM_TYPE, buildCronRuntimeNotice } from "./runtime-notices";

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

describe("appendCronSubagentCompletion", () => {
  it("does not copy subagent usage onto the parent daily-session assistant message", () => {
    const appendedMessages: AgentMessage[] = [];
    const sessionMessages: AgentMessage[] = [];
    const session = {
      model: { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-5.4" },
      messages: sessionMessages,
      agent: { state: { messages: sessionMessages } },
      sessionManager: {
        appendMessage(message: AgentMessage) {
          appendedMessages.push(message);
        },
      },
    } as unknown as AgentSession;

    appendCronSubagentCompletion(session, "subagent-call-1", {
      text: "Delivered report",
      details: { subagent: { prompt: "Do work" } } as any,
      finalAssistant: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret" },
          { type: "text", text: "Delivered report" },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.4",
        usage: {
          input: 1234,
          output: 567,
          cacheRead: 890,
          cacheWrite: 0,
          totalTokens: 2691,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
      isError: false,
    });

    expect(appendedMessages).toHaveLength(2);
    expect(appendedMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Delivered report" }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      },
    });
  });
});

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
          isAssistant: false,
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

    expect(appendedCustomEntries).toHaveLength(1);
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
    expect(appendedMessages).toEqual([
      {
        role: "custom",
        customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:subagent`,
        content: "Subagent run started. Do not call the subagent tool from this session.",
        timestamp: expect.any(Number),
      },
    ]);
  });

  it("does not leak inherited attachments into the initial subagent update", async () => {
    const sessionMessages: AgentMessage[] = [];
    const updates: Array<{ content: Array<{ type: "text"; text: string }>; details: any }> = [];
    const copiedMessages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "attach-old",
        toolName: "attach-files",
        content: [{ type: "text", text: "Attached 1 file for the user." }],
        details: {
          sentFiles: [
            {
              id: "old-file",
              name: "old.png",
              size: 10,
              mimeType: "image/png",
              kind: "image",
              downloadUrl: "/api/sent-files/workspace/session/tool/old-file?download=1",
              previewUrl: "/api/sent-files/workspace/session/tool/old-file",
            },
          ],
        },
        isError: false,
        timestamp: 1,
      } as AgentMessage,
    ];

    const subagentSession = {
      sessionId: "subagent-session-inherited-files",
      sessionFile: "/tmp/subagent-session-inherited-files.jsonl",
      messages: sessionMessages,
      isStreaming: false,
      agent: {
        state: {
          messages: sessionMessages,
        },
      },
      sessionManager: {
        appendCustomEntry() {
          return undefined;
        },
        appendMessage() {
          return undefined;
        },
      },
      subscribe() {
        return () => undefined;
      },
      async prompt() {
        return undefined;
      },
      async abort() {
        return undefined;
      },
    } as unknown as AgentSession;

    await runDetachedSubagentSession(
      {
        async createPiAgentSession() {
          return { session: subagentSession };
        },
        attachSession(workspace, session) {
          return {
            id: "web-subagent-inherited-files",
            workspace,
            session,
            subscribers: new Set(),
            activeTools: new Map(),
            openedAt: 0,
            ephemeral: true,
          };
        },
        disposeWebSession: vi.fn(),
        getSessionMessagesForSubagent() {
          return copiedMessages;
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
          isAssistant: false,
        },
        parentSessionId: "parent-session-inherited-files",
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

    expect(updates).toHaveLength(1);
    expect(updates[0]?.details).not.toHaveProperty("sentFiles");
  });

  it("prepends cron notices in subagent sessions and avoids duplicate copied notices", async () => {
    const appendedMessages: AgentMessage[] = [];
    const sessionMessages: AgentMessage[] = [];
    const cronNotice = buildCronRuntimeNotice("every 1h");
    const copiedMessages: AgentMessage[] = [
      {
        role: "custom",
        customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:cron`,
        content: cronNotice.text,
        timestamp: 10,
      } as AgentMessage,
      {
        role: "user",
        content: "Earlier context",
        timestamp: 11,
      } as AgentMessage,
    ];

    const subagentSession = {
      sessionId: "subagent-session-2",
      sessionFile: "/tmp/subagent-session-2.jsonl",
      messages: sessionMessages,
      isStreaming: false,
      agent: {
        state: {
          messages: sessionMessages,
        },
      },
      sessionManager: {
        appendCustomEntry() {
          return undefined;
        },
        appendMessage(message: AgentMessage) {
          appendedMessages.push(message);
        },
      },
      subscribe() {
        return () => undefined;
      },
      async prompt() {
        return undefined;
      },
      async abort() {
        return undefined;
      },
    } as unknown as AgentSession;

    await runDetachedSubagentSession(
      {
        async createPiAgentSession() {
          return { session: subagentSession };
        },
        attachSession(workspace, session) {
          return {
            id: "web-subagent-2",
            workspace,
            session,
            subscribers: new Set(),
            activeTools: new Map(),
            openedAt: 0,
            ephemeral: true,
          };
        },
        disposeWebSession: vi.fn(),
        getSessionMessagesForSubagent() {
          return copiedMessages;
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
          isAssistant: false,
        },
        parentSessionId: "parent-session-2",
        prompt: "Inspect cron work",
        modelId: "openai/gpt-5",
        thinkingLevel: "medium",
        includeSessionContext: true,
        respondIn: "session",
        preludeNotices: [cronNotice],
      },
    );

    expect(appendedMessages).toHaveLength(3);
    expect(appendedMessages[0]).toMatchObject({
      role: "custom",
      customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:cron`,
      content: cronNotice.text,
    });
    expect(appendedMessages[1]).toMatchObject({
      role: "user",
      content: "Earlier context",
    });
    expect(appendedMessages[2]).toMatchObject({
      role: "custom",
      customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:subagent`,
    });
  });
});
