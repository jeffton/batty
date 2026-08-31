import { describe, expect, it, vi } from "vite-plus/test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
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

function createSession(id: string, sessionFile: string): AgentSession {
  const messages: AgentMessage[] = [];
  return {
    sessionId: id,
    sessionFile,
    model: { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-5.5" },
    get messages() {
      return (this as unknown as { agent: { state: { messages: AgentMessage[] } } }).agent.state
        .messages;
    },
    agent: {
      state: { messages },
      waitForIdle: vi.fn(async () => undefined),
    },
    sessionManager: {
      appendMessage(message: AgentMessage) {
        messages.push(message);
      },
    },
  } as unknown as AgentSession;
}

function createWebSession(id: string, sessionFile: string): WebSession {
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
    session: createSession(id, sessionFile),
    subscribers: new Set(),
    activeTools: new Map(),
    openedAt: 0,
    ephemeral: false,
  } as unknown as WebSession;
}

describe("runCronJobSession", () => {
  it("runs detached daily cron jobs in a cron session and delivers the result to the parent", async () => {
    const parent = createWebSession("daily-session-id", "/tmp/daily-session.jsonl");
    const cron = createWebSession("cron-session-id", "/tmp/cron-session.jsonl");
    const publishReset = vi.fn();
    const onAgentCompleted = vi.fn(async () => undefined);
    const notifyWorkspaceUpdated = vi.fn(async () => undefined);
    const onSessionStarted = vi.fn();
    const prepareSessionForContextCopy = vi.fn(async () => undefined);

    const result = await runCronJobSession(
      {
        createCronSession: vi.fn(async () => ({ id: cron.id }) as never),
        promptCron: vi.fn(async () => {
          cron.session.agent.state.messages = [
            ...cron.session.messages,
            {
              role: "assistant",
              content: [{ type: "text", text: "Heartbeat ok" }],
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
        prepareSessionForContextCopy,
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
      },
    );

    expect(result).toEqual({
      sessionId: "cron-session-id",
      sessionPath: "/tmp/cron-session.jsonl",
    });
    expect(prepareSessionForContextCopy).toHaveBeenCalledWith(parent.id);
    expect(onSessionStarted).toHaveBeenCalledWith({
      sessionId: "cron-session-id",
      sessionPath: "/tmp/cron-session.jsonl",
    });
    expect(parent.session.messages).toHaveLength(2);
    expect(parent.session.messages[0]).toMatchObject({
      role: "custom",
      customType: "batty-runtime-notice:cron",
      content: expect.stringContaining(
        "The detailed work and tool calls for this cron run are in that detached session.",
      ),
      data: { cron: { jobId: "job-1", runId: "run-1", sessionPath: "/tmp/cron-session.jsonl" } },
    });
    expect(parent.session.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Heartbeat ok" }],
      stopReason: "stop",
    });
    expect(parent.session.agent.waitForIdle).toHaveBeenCalled();
    expect(publishReset).toHaveBeenCalled();
    expect(onAgentCompleted).toHaveBeenCalled();
    expect(notifyWorkspaceUpdated).toHaveBeenCalledWith("roy");
  });

  it("does not deliver a successful NO_REPLY result to the daily parent", async () => {
    const parent = createWebSession("daily-session-id", "/tmp/daily-session.jsonl");
    const cron = createWebSession("cron-session-id", "/tmp/cron-session.jsonl");

    const result = await runCronJobSession(
      {
        createCronSession: vi.fn(async () => ({ id: cron.id }) as never),
        promptCron: vi.fn(async () => {
          cron.session.agent.state.messages = [
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
        prepareSessionForContextCopy: vi.fn(async () => undefined),
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
      },
    );

    expect(result.sessionId).toBe("cron-session-id");
    expect(parent.session.messages).toHaveLength(0);
  });

  it("delivers cron errors to the parent before rejecting", async () => {
    const parent = createWebSession("daily-session-id", "/tmp/daily-session.jsonl");
    const cron = createWebSession("cron-session-id", "/tmp/cron-session.jsonl");

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
          prepareSessionForContextCopy: vi.fn(async () => undefined),
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
        },
      ),
    ).rejects.toThrow("detached exploded");

    expect(parent.session.messages).toHaveLength(2);
    expect(parent.session.messages[0]).toMatchObject({
      role: "custom",
      content: expect.stringContaining("/tmp/cron-session.jsonl"),
    });
    expect(parent.session.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "detached exploded" }],
      stopReason: "error",
      errorMessage: "detached exploded",
    });
  });
});
