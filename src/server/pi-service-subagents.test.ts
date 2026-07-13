import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { BATTY_SYSTEM_PROMPT_CUSTOM_TYPE } from "./batty-system-prompt";
import { runDetachedSubagentSession } from "./pi-service-subagents";
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

  it("returns a final auto-retry failure after the prompt settles", async () => {
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
        await new Promise((resolve) => setTimeout(resolve, 200));
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

    let resultSettled = false;
    void resultPromise.then(() => {
      resultSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(aborted).toBe(false);

    subscriber?.({
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "terminated after retries",
    });
    await Promise.resolve();
    expect(resultSettled).toBe(false);

    const result = await resultPromise;
    expect(aborted).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("terminated after retries");
    expect(result.text).toBe("terminated after retries");
  });

  it("waits through overflow compaction and returns the successful retry", async () => {
    const sessionMessages: AgentMessage[] = [];
    let subscriber: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    let aborted = false;

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
        const overflowAssistant = {
          role: "assistant",
          content: [],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.4",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: "Your input exceeds the context window of this model.",
          timestamp: 1,
        } satisfies AssistantMessage;
        sessionMessages.push(overflowAssistant as unknown as AgentMessage);
        subscriber?.({ type: "message_end", message: overflowAssistant });
        sessionMessages.pop();
        subscriber?.({ type: "compaction_start", reason: "overflow" });
        await new Promise((resolve) => setTimeout(resolve, 150));
        subscriber?.({
          type: "compaction_end",
          reason: "overflow",
          result: {},
          aborted: false,
          willRetry: true,
        });
        const recoveredAssistant = createAssistantMessage("Recovered", 2);
        sessionMessages.push(recoveredAssistant as unknown as AgentMessage);
        subscriber?.({ type: "message_end", message: recoveredAssistant });
      },
      async abort() {
        aborted = true;
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

    expect(aborted).toBe(false);
    expect(result.isError).toBe(false);
    expect(result.errorMessage).toBeUndefined();
    expect(result.text).toBe("Recovered");
    expect(result.generatedMessages).toHaveLength(2);
  });

  it("propagates a terminal error removed from the active context before settlement", async () => {
    const sessionMessages: AgentMessage[] = [];
    let subscriber: ((event: { type: string; [key: string]: unknown }) => void) | undefined;

    const subagentSession = {
      sessionId: "subagent-session-idle-terminal-failure",
      sessionFile: "/tmp/subagent-session-idle-terminal-failure.jsonl",
      messages: sessionMessages,
      isStreaming: false,
      isRetrying: false,
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
        const finalAssistant = {
          role: "assistant",
          content: [],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.5",
          usage: {
            input: 10,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: "Your input exceeds the context window of this model.",
          timestamp: 1,
        } satisfies AssistantMessage;
        subscriber?.({ type: "message_end", message: finalAssistant });
        subscriber?.({
          type: "compaction_end",
          reason: "overflow",
          result: undefined,
          aborted: false,
          willRetry: false,
          errorMessage: "Context overflow recovery failed: summarization failed",
        });
      },
      async abort() {
        return undefined;
      },
    } as unknown as AgentSession;

    const resultPromise = runDetachedSubagentSession(
      {
        async createPiAgentSession() {
          return { session: subagentSession };
        },
        attachSession(workspace, session) {
          return {
            id: "web-subagent-idle-terminal-failure",
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
        parentSessionId: "parent-session-idle-terminal-failure",
        prompt: "Inspect the issue",
        modelId: "openai/gpt-5",
        thinkingLevel: "medium",
        includeSessionContext: false,
        respondIn: "session",
      },
    );

    const result = await Promise.race([
      resultPromise,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);

    expect(result).not.toBe("timeout");
    expect(result).toMatchObject({
      isError: true,
      errorMessage: "Context overflow recovery failed: summarization failed",
      text: "Context overflow recovery failed: summarization failed",
      details: {
        subagent: {
          stopReason: "error",
          errorMessage: "Your input exceeds the context window of this model.",
        },
      },
    });
  });

  it("propagates a settled terminal assistant failure even if retry and streaming state are stale", async () => {
    const sessionMessages: AgentMessage[] = [];

    const subagentSession = {
      sessionId: "subagent-session-stale-retry-terminal-failure",
      sessionFile: "/tmp/subagent-session-stale-retry-terminal-failure.jsonl",
      messages: sessionMessages,
      isStreaming: true,
      isRetrying: true,
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
        sessionMessages.push({
          role: "assistant",
          content: [],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.5",
          usage: {
            input: 10,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: "WebSocket closed 1000",
          timestamp: 1,
        } satisfies AssistantMessage as unknown as AgentMessage);
      },
      async abort() {
        return undefined;
      },
    } as unknown as AgentSession;

    const resultPromise = runDetachedSubagentSession(
      {
        async createPiAgentSession() {
          return { session: subagentSession };
        },
        attachSession(workspace, session) {
          return {
            id: "web-subagent-stale-retry-terminal-failure",
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
        parentSessionId: "parent-session-stale-retry-terminal-failure",
        prompt: "Inspect the issue",
        modelId: "openai/gpt-5",
        thinkingLevel: "medium",
        includeSessionContext: false,
        respondIn: "session",
      },
    );

    const result = await Promise.race([
      resultPromise,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);

    expect(result).not.toBe("timeout");
    expect(result).toMatchObject({
      isError: true,
      errorMessage: "WebSocket closed 1000",
      text: "WebSocket closed 1000",
    });
  });

  it("propagates a terminal assistant failure after prompt settlement", async () => {
    const sessionMessages: AgentMessage[] = [];
    let subscriber: ((event: { type: string; [key: string]: unknown }) => void) | undefined;

    const subagentSession = {
      sessionId: "subagent-session-terminal-failure-hung-abort",
      sessionFile: "/tmp/subagent-session-terminal-failure-hung-abort.jsonl",
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
        const errorMessage = "Codex error: server is overloaded";
        const finalAssistant = {
          role: "assistant",
          content: [{ type: "text", text: "Partial response before failure" }],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.5",
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
      },
      async abort() {
        return undefined;
      },
    } as unknown as AgentSession;

    const resultPromise = runDetachedSubagentSession(
      {
        async createPiAgentSession() {
          return { session: subagentSession };
        },
        attachSession(workspace, session) {
          return {
            id: "web-subagent-terminal-failure-hung-abort",
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
        parentSessionId: "parent-session-terminal-failure-hung-abort",
        prompt: "Inspect the issue",
        modelId: "openai/gpt-5",
        thinkingLevel: "medium",
        includeSessionContext: false,
        respondIn: "session",
      },
    );

    const result = await Promise.race([
      resultPromise,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ]);

    expect(result).not.toBe("timeout");
    expect(result).toMatchObject({
      isError: true,
      errorMessage: "Codex error: server is overloaded",
      text: "Codex error: server is overloaded",
    });
  });

  it("aborts compaction that starts immediately after parent cancellation", async () => {
    const sessionMessages: AgentMessage[] = [];
    const controller = new AbortController();
    let subscriber: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    let resolvePrompt!: () => void;
    let notifyPromptStarted!: () => void;
    let compactionControllerReady = false;
    let effectiveCompactionAborts = 0;
    const promptStarted = new Promise<void>((resolve) => {
      notifyPromptStarted = resolve;
    });
    const promptPending = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });

    const subagentSession = {
      sessionId: "subagent-session-cancel-compaction",
      sessionFile: "/tmp/subagent-session-cancel-compaction.jsonl",
      messages: sessionMessages,
      isStreaming: true,
      agent: { state: { messages: sessionMessages } },
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
        notifyPromptStarted();
        await promptPending;
      },
      abortCompaction() {
        if (compactionControllerReady) {
          effectiveCompactionAborts += 1;
        }
      },
      async abort() {
        return undefined;
      },
    } as unknown as AgentSession;

    const resultPromise = runDetachedSubagentSession(
      {
        async createPiAgentSession() {
          return { session: subagentSession };
        },
        attachSession(workspace, session) {
          return {
            id: "web-subagent-cancel-compaction",
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
        parentSessionId: "parent-session-cancel-compaction",
        prompt: "Inspect the issue",
        modelId: "openai/gpt-5",
        thinkingLevel: "medium",
        includeSessionContext: false,
        respondIn: "session",
        signal: controller.signal,
      },
    );

    await promptStarted;
    controller.abort();
    subscriber?.({ type: "compaction_start", reason: "overflow" });
    compactionControllerReady = true;
    await Promise.resolve();
    expect(effectiveCompactionAborts).toBe(1);

    const abortedAssistant = {
      ...createAssistantMessage("", 1),
      content: [],
      stopReason: "aborted",
      errorMessage: "Subagent aborted",
    } satisfies AssistantMessage;
    sessionMessages.push(abortedAssistant as unknown as AgentMessage);
    subscriber?.({ type: "message_end", message: abortedAssistant });
    resolvePrompt();

    await expect(resultPromise).resolves.toMatchObject({
      isError: true,
      errorMessage: "Subagent aborted",
      text: "Subagent aborted",
    });
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
