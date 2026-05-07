import { describe, expect, it, vi } from "vite-plus/test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { WebSession } from "./pi-service-types";
import { recoverDanglingCronSubagent, runCronJobSession } from "./pi-service-cron-adapter";

type AgentMessage = AgentSession["messages"][number];

function createWebSession(): { webSession: WebSession; appendedMessages: AgentMessage[] } {
  const appendedMessages: AgentMessage[] = [];
  const sessionMessages: AgentMessage[] = [
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
    } as AgentMessage,
  ];
  const session = {
    sessionId: "daily-session-1",
    model: { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-5.5" },
    messages: sessionMessages,
    agent: { state: { messages: sessionMessages } },
    sessionManager: {
      appendMessage(message: AgentMessage) {
        appendedMessages.push(message);
      },
    },
  } as unknown as AgentSession;

  return {
    webSession: {
      id: "web-daily-1",
      workspace: {
        id: "batty",
        label: "Batty",
        path: "/tmp/batty",
        kind: "workspace",
        isPinned: true,
        isAssistant: false,
      },
      session,
      subscribers: new Set(),
      activeTools: new Map([["subagent-cron-1", { toolCallId: "subagent-cron-1" } as never]]),
      openedAt: 0,
      ephemeral: false,
    },
    appendedMessages,
  };
}

describe("runCronJobSession", () => {
  it("persists exactly one failed parent completion when the detached subagent reports an error", async () => {
    const appendedMessages: AgentMessage[] = [];
    const sessionMessages: AgentMessage[] = [];
    const webSession = {
      id: "daily-session-state-id",
      workspace: {
        id: "roy",
        label: "Roy",
        path: "/root/github/roy",
        kind: "workspace",
        isPinned: true,
        isAssistant: false,
      },
      session: {
        sessionId: "daily-session-id",
        sessionFile: "/tmp/daily-session.jsonl",
        model: { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-5.5" },
        get messages() {
          return sessionMessages;
        },
        agent: {
          state: { messages: sessionMessages },
          waitForIdle: vi.fn(async () => undefined),
        },
        sessionManager: {
          getLeafId: () => "leaf-id",
          appendMessage(message: AgentMessage) {
            appendedMessages.push(message);
          },
        },
      } as unknown as AgentSession,
      subscribers: new Set(),
      activeTools: new Map(),
      openedAt: 0,
      ephemeral: false,
    } as unknown as WebSession;

    await expect(
      runCronJobSession(
        {
          cronSubagentAbortControllers: new Map(),
          createSession: vi.fn(),
          promptCron: vi.fn(),
          resolveOrCreateDailySession: vi.fn(async () => ({ id: webSession.id }) as never),
          requireSession: vi.fn(() => webSession),
          requireSessionPath: vi.fn(() => "/tmp/daily-session.jsonl"),
          runSubagentSerial: async (_sessionId, run) => run(),
          getState: vi.fn(() => ({ id: webSession.id }) as never),
          publishReset: vi.fn(),
          publishTools: vi.fn(),
          setThinkingLevel: vi.fn(),
          setModel: vi.fn(),
          runDetachedSubagentSession: vi.fn(async () => ({
            text: "WebSocket closed 1000",
            details: { subagent: { errorMessage: "WebSocket closed 1000" } },
            isError: true,
            errorMessage: "WebSocket closed 1000",
          })),
          notifyWorkspaceUpdated: vi.fn(async () => undefined),
        },
        {
          workspace: webSession.workspace,
          prompt: "Run heartbeat",
          model: "openai-codex/gpt-5.5",
          thinkingLevel: "medium",
          session: { kind: "daily-subagent", includePreviousContext: true },
          scheduleLabel: "Every hour",
        },
      ),
    ).rejects.toThrow("WebSocket closed 1000");

    expect(appendedMessages.filter((message) => message.role === "toolResult")).toHaveLength(1);
    expect(appendedMessages.filter((message) => message.role === "toolResult")[0]).toMatchObject({
      toolName: "subagent",
      isError: true,
      details: { subagent: { errorMessage: "WebSocket closed 1000" } },
    });
    expect(appendedMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "WebSocket closed 1000" }],
      stopReason: "error",
      errorMessage: "WebSocket closed 1000",
    });
    expect(webSession.activeTools.size).toBe(0);
  });

  it("persists exactly one failed parent completion when the detached subagent throws", async () => {
    const appendedMessages: AgentMessage[] = [];
    const sessionMessages: AgentMessage[] = [];
    const webSession = {
      id: "daily-session-state-id",
      workspace: {
        id: "roy",
        label: "Roy",
        path: "/root/github/roy",
        kind: "workspace",
        isPinned: true,
        isAssistant: false,
      },
      session: {
        sessionId: "daily-session-id",
        sessionFile: "/tmp/daily-session.jsonl",
        model: { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-5.5" },
        get messages() {
          return sessionMessages;
        },
        agent: {
          state: { messages: sessionMessages },
          waitForIdle: vi.fn(async () => undefined),
        },
        sessionManager: {
          getLeafId: () => "leaf-id",
          appendMessage(message: AgentMessage) {
            appendedMessages.push(message);
          },
        },
      } as unknown as AgentSession,
      subscribers: new Set(),
      activeTools: new Map(),
      openedAt: 0,
      ephemeral: false,
    } as unknown as WebSession;
    const publishTools = vi.fn();
    const publishReset = vi.fn();
    const notifyWorkspaceUpdated = vi.fn(async () => undefined);
    const onAgentCompleted = vi.fn(async () => undefined);

    await expect(
      runCronJobSession(
        {
          cronSubagentAbortControllers: new Map(),
          createSession: vi.fn(),
          promptCron: vi.fn(),
          resolveOrCreateDailySession: vi.fn(async () => ({ id: webSession.id }) as never),
          requireSession: vi.fn(() => webSession),
          requireSessionPath: vi.fn(() => "/tmp/daily-session.jsonl"),
          runSubagentSerial: async (_sessionId, run) => run(),
          getState: vi.fn(() => ({ id: webSession.id }) as never),
          publishReset,
          publishTools,
          setThinkingLevel: vi.fn(),
          setModel: vi.fn(),
          runDetachedSubagentSession: vi.fn(async () => {
            throw new Error("detached exploded");
          }),
          onAgentCompleted,
          notifyWorkspaceUpdated,
        },
        {
          workspace: webSession.workspace,
          prompt: "Run heartbeat",
          model: "openai-codex/gpt-5.5",
          thinkingLevel: "medium",
          session: { kind: "daily-subagent", includePreviousContext: true },
          scheduleLabel: "Every hour",
        },
      ),
    ).rejects.toThrow("detached exploded");

    expect(appendedMessages.filter((message) => message.role === "toolResult")).toHaveLength(1);
    expect(appendedMessages.filter((message) => message.role === "toolResult")[0]).toMatchObject({
      toolName: "subagent",
      isError: true,
    });
    expect(appendedMessages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: "detached exploded",
    });
    expect(publishReset).toHaveBeenCalled();
    expect(publishTools).toHaveBeenCalled();
    expect(onAgentCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        isStreaming: false,
        pendingMessageCount: 0,
        activeAssistant: undefined,
      }),
    );
    expect(notifyWorkspaceUpdated).toHaveBeenCalledWith("roy");
    expect(webSession.activeTools.size).toBe(0);
  });
});

describe("recoverDanglingCronSubagent", () => {
  it("leaves an actively running cron subagent alone unless running abort is requested", () => {
    const { webSession, appendedMessages } = createWebSession();
    const abortController = new AbortController();
    const abortSpy = vi.spyOn(abortController, "abort");
    const cronSubagentAbortControllers = new Map([["subagent-cron-1", abortController]]);

    const recovered = recoverDanglingCronSubagent(
      { cronSubagentAbortControllers },
      webSession,
      "Cron subagent did not finish before the next prompt.",
    );

    expect(recovered).toBe(false);
    expect(abortSpy).not.toHaveBeenCalled();
    expect(cronSubagentAbortControllers.has("subagent-cron-1")).toBe(true);
    expect(webSession.activeTools.has("subagent-cron-1")).toBe(true);
    expect(appendedMessages).toEqual([]);
  });

  it("repairs a failed cron subagent that still has a running controller", () => {
    const { webSession, appendedMessages } = createWebSession();
    const abortController = new AbortController();
    const abortSpy = vi.spyOn(abortController, "abort");
    const cronSubagentAbortControllers = new Map([["subagent-cron-1", abortController]]);
    webSession.activeTools.set("subagent-cron-1", {
      toolCallId: "subagent-cron-1",
      toolName: "subagent",
      args: {},
      blocks: [],
      status: "running",
      isError: false,
      details: { subagent: { sessionId: "child-session-1" } },
    });

    const recovered = recoverDanglingCronSubagent(
      {
        cronSubagentAbortControllers,
        requireSession: vi.fn(() => ({ session: { isStreaming: false } }) as unknown as WebSession),
      },
      webSession,
      "Cron subagent did not finish before the next prompt.",
    );

    expect(recovered).toBe(true);
    expect(abortSpy).toHaveBeenCalledOnce();
    expect(cronSubagentAbortControllers.has("subagent-cron-1")).toBe(false);
    expect(webSession.activeTools.has("subagent-cron-1")).toBe(false);
    expect(appendedMessages).toHaveLength(2);
  });

  it("aborts and completes an actively running cron subagent when requested", () => {
    const { webSession, appendedMessages } = createWebSession();
    const abortController = new AbortController();
    const abortSpy = vi.spyOn(abortController, "abort");
    const cronSubagentAbortControllers = new Map([["subagent-cron-1", abortController]]);

    const recovered = recoverDanglingCronSubagent(
      { cronSubagentAbortControllers },
      webSession,
      "Cron subagent stopped by user.",
      { abortRunning: true },
    );

    expect(recovered).toBe(true);
    expect(abortSpy).toHaveBeenCalledOnce();
    expect(cronSubagentAbortControllers.has("subagent-cron-1")).toBe(false);
    expect(webSession.activeTools.has("subagent-cron-1")).toBe(false);
    expect(appendedMessages).toHaveLength(2);
    expect(appendedMessages[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "subagent-cron-1",
      isError: true,
    });
    expect(appendedMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Cron subagent stopped by user." }],
      stopReason: "error",
      errorMessage: "Cron subagent stopped by user.",
    });
  });

  it("repairs a stale dangling cron subagent when there is no running controller", () => {
    const { webSession, appendedMessages } = createWebSession();
    const cronSubagentAbortControllers = new Map<string, AbortController>();

    const recovered = recoverDanglingCronSubagent(
      { cronSubagentAbortControllers },
      webSession,
      "Cron subagent did not finish before the server stopped.",
    );

    expect(recovered).toBe(true);
    expect(webSession.activeTools.has("subagent-cron-1")).toBe(false);
    expect(appendedMessages).toHaveLength(2);
  });
});
