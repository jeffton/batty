import { describe, expect, it, vi } from "vite-plus/test";
import type { HarnessController as AgentSession } from "./harness-controller";
import type { WebSession } from "./pi-service-types";
import { deliverCronFollowup, runCronJobSession } from "./pi-service-cron-adapter";

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
    const createCronSession = vi.fn(async () => {
      expect(preparingContext).toBe(true);
      return { id: cron.id } as never;
    });

    const result = await runCronJobSession(
      {
        createCronSession,
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
    expect(createCronSession).toHaveBeenCalledWith(
      parent.workspace,
      expect.objectContaining({
        previousContext: {
          sourceSessionPath: "/tmp/daily-session.jsonl",
          mode: true,
        },
      }),
    );
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

  it.each([false, true])(
    "queues a NO_REPLY cron result only when it has an attached file (%s)",
    async (withFile) => {
      const parent = createWebSession("daily-session-id", "/tmp/daily-session.jsonl");
      const cron = createWebSession("cron-session-id", "/tmp/cron-session.jsonl");
      const queueResultDelivery = vi.fn(async () => undefined);

      const result = await runCronJobSession(
        {
          createCronSession: vi.fn(async () => ({ id: cron.id }) as never),
          promptCron: vi.fn(async () => {
            (cron.session as any).agent.state.messages = [
              ...(withFile
                ? [
                    {
                      role: "toolResult",
                      toolCallId: "file-1",
                      toolName: "attach-files",
                      content: [{ type: "text", text: "Attached file" }],
                      details: {
                        sentFiles: [
                          {
                            id: "file-1",
                            name: "report.md",
                            size: 10,
                            mimeType: "text/markdown",
                            kind: "file",
                            downloadUrl: "/report.md",
                          },
                        ],
                      },
                      isError: false,
                      timestamp: 9,
                    } as AgentMessage,
                  ]
                : []),
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
          queueResultDelivery,
        },
      );

      expect(result.sessionId).toBe("cron-session-id");
      expect(queueResultDelivery).toHaveBeenCalledTimes(withFile ? 1 : 0);
      expect(parent.session.messages).toHaveLength(0);
    },
  );

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

describe("deliverCronFollowup", () => {
  it.each(["Follow-up answer", "NO_REPLY"])(
    "delivers %s to the daily session with the reply artifacts",
    async (answer) => {
      const parent = createWebSession("daily-session-id", "/tmp/daily-session.jsonl");
      const cron = createWebSession("cron-session-id", "/tmp/cron-session.jsonl");
      const messages: AgentMessage[] = [
        {
          role: "custom",
          customType: "batty-runtime-notice:subagent",
          content: "Async subagent completed",
          data: {
            subagent: { sessionId: "child-id" },
            sentFiles:
              answer === "NO_REPLY"
                ? []
                : [
                    {
                      id: "child-file",
                      name: "child.md",
                      size: 10,
                      mimeType: "text/markdown",
                      kind: "file",
                      downloadUrl: "/child.md",
                    },
                  ],
          },
          timestamp: 1,
        } as unknown as AgentMessage,
        {
          role: "toolResult",
          toolCallId: "shared-site",
          toolName: "sites",
          content: [{ type: "text", text: "Shared site" }],
          details: {
            sites:
              answer === "NO_REPLY"
                ? []
                : [{ id: "site-1", name: "Site", url: "/sites/site-1", public: false }],
          },
          isError: false,
          timestamp: 2,
        } as AgentMessage,
        {
          role: "toolResult",
          toolCallId: "attached-file",
          toolName: "attach-files",
          content: [{ type: "text", text: "Attached file" }],
          details: {
            sentFiles:
              answer === "NO_REPLY"
                ? []
                : [
                    {
                      id: "file-1",
                      name: "report.md",
                      size: 10,
                      mimeType: "text/markdown",
                      kind: "file",
                      downloadUrl: "/report.md",
                    },
                  ],
          },
          isError: false,
          timestamp: 2,
        } as AgentMessage,
        {
          role: "assistant",
          content: [{ type: "text", text: answer }],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.5",
          usage: ZERO_USAGE,
          stopReason: "stop",
          timestamp: 3,
        },
      ];
      cron.session.snapshot.lastResult = {
        operationId: "followup-1",
        fromTipId: "binding",
        tipId: "reply-3",
      } as never;
      vi.spyOn(cron.session.sessionManager, "getEntries").mockImplementation(
        () =>
          [
            {
              id: "binding",
              type: "custom",
              customType: "batty-cron-run-session",
              data: {
                version: 1,
                kind: "run",
                jobId: "job-1",
                runId: "run-1",
                parentSessionId: parent.id,
              },
            },
            ...messages.map((message, index) => ({
              id: `reply-${index}`,
              type: "message",
              message,
              parentId: index ? `reply-${index - 1}` : "binding",
            })),
          ] as ReturnType<AgentSession["sessionManager"]["getEntries"]>,
      );
      const publishReset = vi.fn();
      const context = {
        openSessionById: vi.fn(async () => ({ id: parent.id }) as never),
        requireSession: vi.fn(() => parent),
        runSubagentSerial: async <T>(_sessionId: string, run: () => Promise<T>) => run(),
        getState: vi.fn(() => ({ id: parent.id }) as never),
        publishReset,
        notifyWorkspaceUpdated: vi.fn(async () => undefined),
      };

      await deliverCronFollowup(context, parent.workspace, cron.session);

      expect(parent.session.messages).toHaveLength(answer === "NO_REPLY" ? 0 : 4);
      if (answer !== "NO_REPLY") {
        expect(parent.session.messages[0]).toMatchObject({
          customType: "batty-runtime-notice:cron",
        });
        expect(parent.session.messages[1]).toMatchObject({
          details: { sites: [{ id: "site-1" }] },
        });
        expect(parent.session.messages[2]).toMatchObject({
          details: { sentFiles: [{ id: "child-file" }, { id: "file-1" }] },
        });
        expect(parent.session.messages[3]).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: answer }],
        });
      }
      expect(publishReset).toHaveBeenCalledTimes(answer === "NO_REPLY" ? 0 : 1);

      // A steered subagent result can finish in the original cron operation.
      cron.session.snapshot.lastResult = {
        operationId: "run-1",
        fromTipId: "binding",
        tipId: "reply-3",
      } as never;
      await deliverCronFollowup(context, parent.workspace, cron.session);
      expect(parent.session.messages).toHaveLength(answer === "NO_REPLY" ? 0 : 4);
    },
  );

  it("forwards a regular cron-session reply without an async subagent", async () => {
    const parent = createWebSession("daily-session-id", "/tmp/daily-session.jsonl");
    const cron = createWebSession("cron-session-id", "/tmp/cron-session.jsonl");
    cron.session.snapshot.lastResult = {
      operationId: "manual-followup",
      fromTipId: "binding",
      tipId: "answer",
    } as never;
    vi.spyOn(cron.session.sessionManager, "getEntries").mockReturnValue([
      {
        id: "binding",
        type: "custom",
        customType: "batty-cron-run-session",
        data: {
          version: 1,
          kind: "run",
          jobId: "job-1",
          runId: "run-1",
          parentSessionId: parent.id,
        },
      },
      {
        id: "prompt",
        parentId: "binding",
        type: "message",
        message: { role: "user", content: "Check again", timestamp: 1 },
      },
      {
        id: "answer",
        parentId: "prompt",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The update" }],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.5",
          usage: ZERO_USAGE,
          stopReason: "stop",
          timestamp: 2,
        },
      },
    ] as ReturnType<AgentSession["sessionManager"]["getEntries"]>);

    await deliverCronFollowup(
      {
        openSessionById: async () => ({ id: parent.id }) as never,
        requireSession: () => parent,
        runSubagentSerial: async (_sessionId, run) => run(),
        getState: () => ({ id: parent.id }) as never,
        publishReset: vi.fn(),
        notifyWorkspaceUpdated: vi.fn(async () => undefined),
      },
      parent.workspace,
      cron.session,
    );

    expect(parent.session.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "The update" }],
    });
  });
});
