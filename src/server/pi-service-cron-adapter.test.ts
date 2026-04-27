import { describe, expect, it, vi } from "vite-plus/test";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { WebSession } from "./pi-service-types";
import { recoverDanglingCronSubagent } from "./pi-service-cron-adapter";

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
