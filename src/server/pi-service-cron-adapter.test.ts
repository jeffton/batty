import { describe, expect, it, vi } from "vite-plus/test";
import type { HarnessController as AgentSession } from "./harness-controller";
import type { WebSession } from "./pi-service-types";
import { runCronJobSession } from "./pi-service-cron-adapter";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type AgentMessage = AgentSession["messages"][number];

function createSession(
  id: string,
  sessionFile: string,
  operationBaseEntryId: string | null = null,
): AgentSession {
  const messages: AgentMessage[] = [];
  const session = {
    sessionId: id,
    sessionFile,
    model: { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-5.5" },
    get messages() {
      return (this as unknown as { agent: { state: { messages: AgentMessage[] } } }).agent.state
        .messages;
    },
    agent: { state: { messages } },
    waitForIdle: vi.fn(async () => undefined),
    snapshot: { queues: [] },
    lane: {
      appendMessage: async (message: AgentMessage) => {
        messages.push(message);
      },
      getResult: async () => ({
        tipId: session.messages.length ? String(session.messages.length - 1) : null,
        fromTipId: operationBaseEntryId,
      }),
    },
    sessionManager: {
      getEntries: () =>
        session.messages.map((message, index) => ({
          id: String(index),
          type: "message",
          message,
          parentId: index > 0 ? String(index - 1) : null,
        })),
      native: {
        findEntries: async () => messages.map((message) => ({ type: "message", message })),
        getEntry: async (id: string) => ({
          type: "message",
          message: session.messages[Number(id)],
          parentId: Number(id) > 0 ? String(Number(id) - 1) : null,
        }),
      },
      appendMessage(message: AgentMessage) {
        messages.push(message);
      },
    },
  } as unknown as AgentSession;
  return session;
}

function createWebSession(
  id: string,
  sessionFile: string,
  operationBaseEntryId: string | null = null,
): WebSession {
  return {
    id,
    workspace: {
      id: "roy",
      label: "Roy",
      path: "/root/github/roy",
      kind: "workspace",
      isPinned: true,
      isAssistant: false,
    },
    session: createSession(id, sessionFile, operationBaseEntryId),
    subscribers: new Set(),
    activeTools: new Map(),
    openedAt: 0,
    ephemeral: false,
  } as unknown as WebSession;
}

describe("runCronJobSession", () => {
  it("runs detached daily cron jobs in a cron session and delivers the result to the parent", async () => {
    const parent = createWebSession("daily-session-id", "/tmp/daily-session.jsonl");
    const cron = createWebSession("cron-session-id", "/tmp/cron-session.jsonl", "2");
    const publishReset = vi.fn();
    const onAgentCompleted = vi.fn(async () => undefined);
    const notifyWorkspaceUpdated = vi.fn(async () => undefined);
    const onSessionStarted = vi.fn();
    const queueResultDelivery = vi.fn(async () => undefined);
    const prepareSessionForContextCopy = vi.fn();
    let preparingContext = false;
    const copyPreparedSession = async <T>(sessionId: string, copy: () => Promise<T>) => {
      prepareSessionForContextCopy(sessionId, copy);
      preparingContext = true;
      try {
        return await copy();
      } finally {
        preparingContext = false;
      }
    };

    const result = await runCronJobSession(
      {
        createCronSession: vi.fn(async () => {
          expect(preparingContext).toBe(true);
          return { id: cron.id } as never;
        }),
        promptCron: vi.fn(async () => {
          (cron.session as any).agent.state.messages = [
            { role: "user", content: "Inherited context", timestamp: 1 },
            {
              role: "toolResult",
              toolCallId: "inherited-tool",
              toolName: "write",
              content: [{ type: "text", text: "inherited" }],
              details: {
                battyFileChanges: [{ path: "inherited.txt", before: "", after: "old" }],
              },
              timestamp: 2,
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "Earlier result" }],
              api: "openai-codex-responses",
              provider: "openai-codex",
              model: "gpt-5.5",
              usage: ZERO_USAGE,
              stopReason: "stop",
              timestamp: 3,
            },
            {
              role: "toolResult",
              toolCallId: "child-tool",
              toolName: "write",
              content: [{ type: "text", text: "child" }],
              details: {
                battyFileChanges: [{ path: "child.txt", before: "", after: "new" }],
              },
              timestamp: 9,
            },
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "internal" },
                { type: "text", text: "Heartbeat ok" },
              ],
              api: "openai-codex-responses",
              provider: "openai-codex",
              model: "gpt-5.5",
              usage: ZERO_USAGE,
              stopReason: "stop",
              timestamp: 10,
            } as AgentMessage,
          ];
        }),
        resolveOrCreateDailySession: vi.fn(
          async () => ({ id: parent.id, sessionId: parent.id }) as never,
        ),
        requireSession: vi.fn((sessionId) => (sessionId === cron.id ? cron : parent)),
        requireSessionPath: vi.fn((sessionId) =>
          sessionId === cron.id ? cron.session.sessionFile! : parent.session.sessionFile!,
        ),
        prepareSessionForContextCopy: copyPreparedSession,
        runSubagentSerial: async (_sessionId, run) => run(),
        getState: vi.fn((sessionId) => ({ id: sessionId, workspaceId: "roy" }) as never),
        publishReset,
        setThinkingLevel: vi.fn(),
        setModel: vi.fn(),
        onAgentCompleted,
        notifyWorkspaceUpdated,
      },
      {
        jobId: "job-1",
        runId: "run-1",
        workspace: parent.workspace,
        prompt: "Run heartbeat",
        model: "openai-codex/gpt-5.5",
        thinkingLevel: "medium",
        session: { kind: "daily-detached", includePreviousContext: true },
        scheduleLabel: "Every hour",
        signal: new AbortController().signal,
        onSessionStarted,
        queueResultDelivery,
      },
    );

    expect(result).toEqual({
      sessionId: "cron-session-id",
      sessionPath: "/tmp/cron-session.jsonl",
    });
    expect(prepareSessionForContextCopy).toHaveBeenCalledWith(parent.id, expect.any(Function));
    expect(onSessionStarted).toHaveBeenCalledWith({
      sessionId: "cron-session-id",
      sessionPath: "/tmp/cron-session.jsonl",
    });
    expect(queueResultDelivery).toHaveBeenCalledWith(parent.session.sessionId);
    expect(parent.session.messages).toHaveLength(0);
    expect(parent.session.waitForIdle).not.toHaveBeenCalled();
    expect(publishReset).not.toHaveBeenCalled();
    expect(onAgentCompleted).not.toHaveBeenCalled();
    expect(notifyWorkspaceUpdated).not.toHaveBeenCalled();
  });

  it("applies an inline cron job's effort after switching to its model", async () => {
    const daily = createWebSession("daily-session-id", "/tmp/daily-session.jsonl");
    const calls: string[] = [];
    vi.mocked(daily.session.waitForIdle).mockImplementation(async () => {
      calls.push("wait");
    });

    await runCronJobSession(
      {
        createCronSession: vi.fn(),
        promptCron: vi.fn(async () => {
          calls.push("prompt");
        }),
        resolveOrCreateDailySession: vi.fn(
          async () => ({ id: daily.id, sessionId: daily.id }) as never,
        ),
        requireSession: vi.fn(() => daily),
        requireSessionPath: vi.fn(() => daily.session.sessionFile!),
        prepareSessionForContextCopy: async (_sessionId, copy) => copy(),
        runSubagentSerial: async (_sessionId, run) => run(),
        getState: vi.fn((sessionId) => ({ id: sessionId, workspaceId: "roy" }) as never),
        publishReset: vi.fn(),
        setThinkingLevel: vi.fn(async (_sessionId, level) => {
          calls.push(`effort:${level}`);
          return { id: daily.id, workspaceId: "roy" } as never;
        }),
        setModel: vi.fn(async (_sessionId, modelId) => {
          calls.push(`model:${modelId}`);
          return { id: daily.id, workspaceId: "roy" } as never;
        }),
        notifyWorkspaceUpdated: vi.fn(async () => undefined),
      },
      {
        jobId: "job-1",
        runId: "run-inline",
        workspace: daily.workspace,
        prompt: "Run heartbeat",
        model: "openai-codex/gpt-6-astra",
        thinkingLevel: "max",
        session: { kind: "daily-inline" },
        scheduleLabel: "Every hour",
        signal: new AbortController().signal,
        onSessionStarted: vi.fn(async () => {
          calls.push("started");
        }),
        queueResultDelivery: vi.fn(async () => undefined),
      },
    );

    expect(calls).toEqual([
      "started",
      "wait",
      "model:openai-codex/gpt-6-astra",
      "effort:max",
      "prompt",
    ]);
  });

  it("does not deliver a successful NO_REPLY result to the daily parent", async () => {
    const parent = createWebSession("daily-session-id", "/tmp/daily-session.jsonl");
    const cron = createWebSession("cron-session-id", "/tmp/cron-session.jsonl");

    const result = await runCronJobSession(
      {
        createCronSession: vi.fn(async () => ({ id: cron.id }) as never),
        promptCron: vi.fn(async () => {
          (cron.session as any).agent.state.messages = [
            {
              role: "assistant",
              content: [{ type: "text", text: "  NO_REPLY  " }],
              api: "openai-codex-responses",
              provider: "openai-codex",
              model: "gpt-5.5",
              usage: ZERO_USAGE,
              stopReason: "stop",
              timestamp: 10,
            } as AgentMessage,
          ];
        }),
        resolveOrCreateDailySession: vi.fn(
          async () => ({ id: parent.id, sessionId: parent.id }) as never,
        ),
        requireSession: vi.fn((sessionId) => (sessionId === cron.id ? cron : parent)),
        requireSessionPath: vi.fn((sessionId) =>
          sessionId === cron.id ? cron.session.sessionFile! : parent.session.sessionFile!,
        ),
        prepareSessionForContextCopy: async (_sessionId, copy) => copy(),
        runSubagentSerial: async (_sessionId, run) => run(),
        getState: vi.fn((sessionId) => ({ id: sessionId, workspaceId: "roy" }) as never),
        publishReset: vi.fn(),
        setThinkingLevel: vi.fn(),
        setModel: vi.fn(),
        onAgentCompleted: vi.fn(async () => undefined),
        notifyWorkspaceUpdated: vi.fn(async () => undefined),
      },
      {
        jobId: "job-1",
        runId: "run-no-reply",
        workspace: parent.workspace,
        prompt: "Run heartbeat",
        model: "openai-codex/gpt-5.5",
        thinkingLevel: "medium",
        session: { kind: "daily-detached", includePreviousContext: false },
        scheduleLabel: "Every hour",
        signal: new AbortController().signal,
        onSessionStarted: vi.fn(),
        queueResultDelivery: vi.fn(async () => undefined),
      },
    );

    expect(result.sessionId).toBe("cron-session-id");
    expect(parent.session.messages).toHaveLength(0);
  });

  it("queues cron errors for parent delivery when rejecting", async () => {
    const parent = createWebSession("daily-session-id", "/tmp/daily-session.jsonl");
    const cron = createWebSession("cron-session-id", "/tmp/cron-session.jsonl");

    const queueResultDelivery = vi.fn(async () => undefined);
    await expect(
      runCronJobSession(
        {
          createCronSession: vi.fn(async () => ({ id: cron.id }) as never),
          promptCron: vi.fn(async () => {
            throw new Error("detached exploded");
          }),
          resolveOrCreateDailySession: vi.fn(
            async () => ({ id: parent.id, sessionId: parent.id }) as never,
          ),
          requireSession: vi.fn((sessionId) => (sessionId === cron.id ? cron : parent)),
          requireSessionPath: vi.fn((sessionId) =>
            sessionId === cron.id ? cron.session.sessionFile! : parent.session.sessionFile!,
          ),
          prepareSessionForContextCopy: async (_sessionId, copy) => copy(),
          runSubagentSerial: async (_sessionId, run) => run(),
          getState: vi.fn((sessionId) => ({ id: sessionId, workspaceId: "roy" }) as never),
          publishReset: vi.fn(),
          setThinkingLevel: vi.fn(),
          setModel: vi.fn(),
          notifyWorkspaceUpdated: vi.fn(async () => undefined),
        },
        {
          jobId: "job-1",
          runId: "run-1",
          workspace: parent.workspace,
          prompt: "Run heartbeat",
          model: "openai-codex/gpt-5.5",
          thinkingLevel: "medium",
          session: { kind: "daily-detached", includePreviousContext: false },
          scheduleLabel: "Every hour",
          signal: new AbortController().signal,
          onSessionStarted: vi.fn(),
          queueResultDelivery,
        },
      ),
    ).rejects.toThrow("detached exploded");

    expect(queueResultDelivery).toHaveBeenCalledWith(parent.session.sessionId);
    expect(parent.session.messages).toHaveLength(0);
  });
});
