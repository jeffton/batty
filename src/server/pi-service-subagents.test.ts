import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { SessionManager, type AgentSession } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { BATTY_SYSTEM_PROMPT_CUSTOM_TYPE } from "./batty-system-prompt";
import {
  appendCronSubagentCompletion,
  appendDanglingCronSubagentFailure,
  findDanglingCronSubagentToolCall,
  runDetachedSubagentSession,
} from "./pi-service-subagents";
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

describe("cron subagent transcript repair", () => {
  it("finds and completes a dangling simulated cron subagent tool call", () => {
    const appendedMessages: AgentMessage[] = [];
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "Run heartbeat", timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "subagent-cron-1",
            name: "subagent",
            arguments: {
              prompt: "Run heartbeat",
              model: "openai-codex/gpt-5.5",
              effort: "medium",
              includeSessionContext: true,
            },
          },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.5",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
    ];
    const session = {
      model: { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-5.5" },
      messages: sessionMessages,
      agent: { state: { messages: sessionMessages } },
      sessionManager: {
        appendMessage(message: AgentMessage) {
          appendedMessages.push(message);
        },
      },
    } as unknown as AgentSession;

    expect(findDanglingCronSubagentToolCall(session)).toMatchObject({ id: "subagent-cron-1" });
    expect(appendDanglingCronSubagentFailure(session, "Cron subagent died")).toBe(true);

    expect(appendedMessages).toHaveLength(2);
    expect(appendedMessages[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "subagent-cron-1",
      toolName: "subagent",
      isError: true,
    });
    expect(appendedMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Cron subagent died" }],
      stopReason: "error",
      errorMessage: "Cron subagent died",
    });
  });

  it("leaves completed subagent transcripts alone", () => {
    const sessionMessages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "subagent-cron-1", name: "subagent", arguments: {} }],
        timestamp: 1,
      } as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "subagent-cron-1",
        toolName: "subagent",
        content: [],
        isError: false,
        timestamp: 2,
      } as AgentMessage,
    ];
    const session = { messages: sessionMessages } as unknown as AgentSession;

    expect(findDanglingCronSubagentToolCall(session)).toBeUndefined();
  });
});

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

  it("synthesizes a visible parent error message when the subagent ended with empty content", () => {
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

    appendCronSubagentCompletion(session, "subagent-call-2", {
      text: "Codex error: upstream overloaded",
      details: { subagent: { prompt: "Do work" } } as any,
      finalAssistant: {
        role: "assistant",
        content: [],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.4",
        usage: {
          input: 10,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 10,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "Codex error: upstream overloaded",
        timestamp: 2,
      },
      isError: true,
      errorMessage: "Codex error: upstream overloaded",
    });

    expect(appendedMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Codex error: upstream overloaded" }],
      stopReason: "error",
      errorMessage: "Codex error: upstream overloaded",
    });
  });
});

describe("runDetachedSubagentSession", () => {
  it("branches inherited context from the parent session before the current tool call", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-subagent-workspace-"));
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-subagent-sessions-"));
    const parentManager = SessionManager.create(workspaceDir, sessionDir);
    parentManager.appendCustomEntry(BATTY_SYSTEM_PROMPT_CUSTOM_TYPE, {
      appendedPrompt: "cached parent prompt",
      workspaceId: "batty",
      workspacePath: workspaceDir,
      model: "parent/model",
      thinkingLevel: "medium",
      date: "2026-04-24",
      isoWeek: 17,
    });
    parentManager.appendMessage({ role: "user", content: "Parent request", timestamp: 1 });
    parentManager.appendMessage(createAssistantMessage("Parent answer", 2));
    parentManager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "subagent-call-1",
          name: "subagent",
          arguments: { prompt: "Child work" },
        },
      ],
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
      stopReason: "toolUse",
      timestamp: 3,
    } satisfies AssistantMessage);
    const parentSessionPath = parentManager.getSessionFile();
    if (!parentSessionPath) {
      throw new Error("Expected persisted parent session");
    }

    let branchedContextMessages: AgentMessage[] = [];
    let branchedPromptEntry: unknown;
    let branchedParentSession: string | undefined;

    const result = await runDetachedSubagentSession(
      {
        async createPiAgentSession(_workspace, sessionManager) {
          branchedContextMessages = sessionManager.buildSessionContext().messages as AgentMessage[];
          branchedPromptEntry = (
            sessionManager
              .getEntries()
              .find(
                (entry) =>
                  entry.type === "custom" && entry.customType === BATTY_SYSTEM_PROMPT_CUSTOM_TYPE,
              ) as { data?: unknown } | undefined
          )?.data;
          branchedParentSession = sessionManager.getHeader()?.parentSession;
          const subagentSession = {
            sessionId: sessionManager.getSessionId(),
            sessionFile: sessionManager.getSessionFile() ?? "",
            get messages() {
              return sessionManager.buildSessionContext().messages as AgentMessage[];
            },
            isStreaming: false,
            agent: { state: { messages: [] } },
            sessionManager,
            subscribe() {
              return () => undefined;
            },
            async prompt() {
              sessionManager.appendMessage(createAssistantMessage("Child done", 4));
            },
            async abort() {
              return undefined;
            },
          } as unknown as AgentSession;
          return { session: subagentSession };
        },
        attachSession(workspace, session) {
          return {
            id: "web-subagent-branch",
            workspace,
            session,
            subscribers: new Set(),
            activeTools: new Map(),
            openedAt: 0,
            ephemeral: true,
          };
        },
        disposeWebSession: vi.fn(),
        workspaceSessionDir: sessionDir,
      },
      {
        workspace: {
          id: "batty",
          label: "Batty",
          path: workspaceDir,
          kind: "workspace",
          isPinned: true,
          isAssistant: false,
        },
        parentSessionId: parentManager.getSessionId(),
        parentSessionPath,
        prompt: "Child work",
        modelId: "child/model",
        thinkingLevel: "high",
        includeSessionContext: true,
        respondIn: "session",
        currentToolCallId: "subagent-call-1",
      },
    );

    expect(branchedContextMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(branchedContextMessages).not.toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([expect.objectContaining({ type: "toolCall" })]),
      }),
    );
    expect(branchedPromptEntry).toMatchObject({
      appendedPrompt: "cached parent prompt",
      model: "parent/model",
      thinkingLevel: "medium",
    });
    expect(branchedParentSession).toBe(parentSessionPath);
    expect(result.text).toBe("Child done");
  });

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
        includeSessionContext: false,
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
        includeSessionContext: false,
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

  it("returns after final auto-retry failure even if prompt never settles", async () => {
    const sessionMessages: AgentMessage[] = [];
    let subscriber: ((event: { type: string; [key: string]: unknown }) => void) | undefined;

    const subagentSession = {
      sessionId: "subagent-session-retry-failure",
      sessionFile: "/tmp/subagent-session-retry-failure.jsonl",
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
      subscribe(callback: (event: { type: string; [key: string]: unknown }) => void) {
        subscriber = callback;
        return () => undefined;
      },
      async prompt() {
        const errorMessage = "Codex error: upstream overloaded";
        const finalAssistant = {
          role: "assistant",
          content: [],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.4",
          usage: {
            input: 10,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage,
          timestamp: 1,
        } satisfies AssistantMessage;
        sessionMessages.push(finalAssistant as unknown as AgentMessage);
        subscriber?.({ type: "message_end", message: finalAssistant });
        subscriber?.({
          type: "auto_retry_end",
          success: false,
          attempt: 3,
          finalError: errorMessage,
        });
        return new Promise<void>(() => undefined);
      },
      async abort() {
        return undefined;
      },
    } as unknown as AgentSession;

    const result = await runDetachedSubagentSession(
      {
        async createPiAgentSession() {
          return { session: subagentSession };
        },
        attachSession(workspace, session) {
          return {
            id: "web-subagent-retry-failure",
            workspace,
            session,
            subscribers: new Set(),
            activeTools: new Map(),
            openedAt: 0,
            ephemeral: true,
          };
        },
        disposeWebSession: vi.fn(),
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
        parentSessionId: "parent-session-retry-failure",
        prompt: "Inspect the issue",
        modelId: "openai/gpt-5",
        thinkingLevel: "medium",
        includeSessionContext: false,
        respondIn: "session",
      },
    );

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("Codex error: upstream overloaded");
    expect(result.text).toBe("Codex error: upstream overloaded");
  });

  it("waits for auto-retry failure after a retryable terminal assistant failure", async () => {
    const sessionMessages: AgentMessage[] = [];
    let subscriber: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    let aborted = false;

    const subagentSession = {
      sessionId: "subagent-session-retry-start",
      sessionFile: "/tmp/subagent-session-retry-start.jsonl",
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
      subscribe(callback: (event: { type: string; [key: string]: unknown }) => void) {
        subscriber = callback;
        return () => undefined;
      },
      async prompt() {
        const errorMessage = "terminated";
        const finalAssistant = {
          role: "assistant",
          content: [],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.4",
          usage: {
            input: 10,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage,
          timestamp: 1,
        } satisfies AssistantMessage;
        sessionMessages.push(finalAssistant as unknown as AgentMessage);
        subscriber?.({ type: "message_end", message: finalAssistant });
        subscriber?.({
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 1000,
          errorMessage,
        });
        return new Promise<void>(() => undefined);
      },
      async abort() {
        aborted = true;
      },
    } as unknown as AgentSession;

    const resultPromise = runDetachedSubagentSession(
      {
        async createPiAgentSession() {
          return { session: subagentSession };
        },
        attachSession(workspace, session) {
          return {
            id: "web-subagent-retry-start",
            workspace,
            session,
            subscribers: new Set(),
            activeTools: new Map(),
            openedAt: 0,
            ephemeral: true,
          };
        },
        disposeWebSession: vi.fn(),
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
        parentSessionId: "parent-session-retry-start",
        prompt: "Inspect the issue",
        modelId: "openai/gpt-5",
        thinkingLevel: "medium",
        includeSessionContext: false,
        respondIn: "session",
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(aborted).toBe(false);

    subscriber?.({
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "terminated after retries",
    });

    const result = await resultPromise;
    expect(aborted).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("terminated after retries");
    expect(result.text).toBe("terminated after retries");
  });

  it("returns after a direct terminal assistant failure even if prompt never settles", async () => {
    const sessionMessages: AgentMessage[] = [];
    let subscriber: ((event: { type: string; [key: string]: unknown }) => void) | undefined;

    const subagentSession = {
      sessionId: "subagent-session-terminal-failure",
      sessionFile: "/tmp/subagent-session-terminal-failure.jsonl",
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
      subscribe(callback: (event: { type: string; [key: string]: unknown }) => void) {
        subscriber = callback;
        return () => undefined;
      },
      async prompt() {
        const errorMessage = "Codex error: request failed";
        const finalAssistant = {
          role: "assistant",
          content: [],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.4",
          usage: {
            input: 10,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage,
          timestamp: 1,
        } satisfies AssistantMessage;
        sessionMessages.push(finalAssistant as unknown as AgentMessage);
        subscriber?.({ type: "message_end", message: finalAssistant });
        return new Promise<void>(() => undefined);
      },
      async abort() {
        return undefined;
      },
    } as unknown as AgentSession;

    const result = await runDetachedSubagentSession(
      {
        async createPiAgentSession() {
          return { session: subagentSession };
        },
        attachSession(workspace, session) {
          return {
            id: "web-subagent-terminal-failure",
            workspace,
            session,
            subscribers: new Set(),
            activeTools: new Map(),
            openedAt: 0,
            ephemeral: true,
          };
        },
        disposeWebSession: vi.fn(),
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
        parentSessionId: "parent-session-terminal-failure",
        prompt: "Inspect the issue",
        modelId: "openai/gpt-5",
        thinkingLevel: "medium",
        includeSessionContext: false,
        respondIn: "session",
      },
    );

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("Codex error: request failed");
    expect(result.text).toBe("Codex error: request failed");
  });

  it("does not leak preexisting child-session attachments into the initial subagent update", async () => {
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
    const sessionMessages: AgentMessage[] = [...copiedMessages];

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
        includeSessionContext: false,
        respondIn: "session",
        onUpdate: (partial) => {
          updates.push(partial);
        },
      },
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]?.details).not.toHaveProperty("sentFiles");
  });

  it("appends cron notices after existing subagent session context", async () => {
    const appendedMessages: AgentMessage[] = [];
    const cronNotice = buildCronRuntimeNotice({
      scheduleLabel: "every 1h",
      prompt: "Inspect cron work",
    });
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
    const sessionMessages: AgentMessage[] = [...copiedMessages];

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
        includeSessionContext: false,
        respondIn: "session",
        preludeNotices: [cronNotice],
      },
    );

    expect(appendedMessages).toHaveLength(2);
    expect(appendedMessages[0]).toMatchObject({
      role: "custom",
      customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:cron`,
      content: cronNotice.text,
    });
    expect(appendedMessages[1]).toMatchObject({
      role: "custom",
      customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:subagent`,
    });
  });
});
