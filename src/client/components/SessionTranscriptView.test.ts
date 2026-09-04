import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vite-plus/test";
import SessionTranscriptView from "@/client/components/SessionTranscriptView.vue";
import type { SessionState } from "@/shared/types";

function createSession(sessionId: string): SessionState {
  return {
    id: sessionId,
    sessionId,
    workspaceId: "batty",
    cwd: "/root/github/batty",
    path: `/tmp/${sessionId}.jsonl`,
    thinkingLevel: "medium",
    availableThinkingLevels: ["medium"],
    isStreaming: false,
    pendingMessageCount: 0,
    updatedAt: 1,
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    totalMessageCount: 2,
    hasMoreMessages: true,
    messagesDetailLevel: "full",
    messages: [
      {
        id: `assistant-${sessionId}-1`,
        role: "assistant",
        turnPhase: "final",
        timestamp: 1,
        blocks: [{ type: "text", text: `Latest ${sessionId}` }],
      },
    ],
    activeTools: [],
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SessionTranscriptView assistant phases", () => {
  it("moves a streamed response from pending through intermediate to final semantics", async () => {
    const userMessage = {
      id: "user-1",
      role: "user" as const,
      timestamp: 1,
      blocks: [{ type: "text" as const, text: "Inspect the repository" }],
    };
    const session = {
      ...createSession("session-phases"),
      isStreaming: true,
      hasMoreMessages: false,
      totalMessageCount: 1,
      messages: [userMessage],
      activeAssistant: {
        id: "assistant-pending",
        role: "assistant" as const,
        turnPhase: "pending" as const,
        timestamp: 2,
        blocks: [{ type: "text" as const, text: "I will inspect it." }],
      },
    };
    const wrapper = mount(SessionTranscriptView, {
      props: {
        session,
        loadOlderMessages: vi.fn(async () => undefined),
      },
    });

    expect(wrapper.find(".message__segment--bubble").exists()).toBe(true);
    expect(wrapper.find(".message__copy-button").exists()).toBe(false);
    expect(wrapper.findAll(".message__timestamp")).toHaveLength(1);

    await wrapper.setProps({
      session: {
        ...session,
        activeAssistant: {
          ...session.activeAssistant,
          turnPhase: "intermediate",
          blocks: [
            { type: "text" as const, text: "I will inspect it." },
            { type: "thinking" as const, thinking: "Checking files." },
            {
              type: "toolCall" as const,
              id: "call-1",
              name: "read",
              arguments: { path: "README.md" },
            },
          ],
        },
      },
    });

    expect(wrapper.find(".message__copy-button").exists()).toBe(false);
    expect(wrapper.findAll(".message__timestamp")).toHaveLength(1);
    expect(wrapper.find(".markdown-body--thinking").exists()).toBe(true);

    await wrapper.setProps({
      session: {
        ...session,
        isStreaming: false,
        totalMessageCount: 2,
        messages: [
          userMessage,
          {
            id: "assistant-final",
            role: "assistant",
            turnPhase: "final",
            timestamp: 10 * 60 * 1000 + 1,
            blocks: [
              { type: "text", text: "The repository is ready." },
              { type: "thinking", thinking: "Finished checking files." },
            ],
          },
        ],
        activeAssistant: undefined,
      },
    });
    await flushPromises();

    expect(wrapper.find(".message__copy-button").exists()).toBe(true);
    expect(wrapper.findAll(".message__timestamp")).toHaveLength(2);
    expect(wrapper.find(".transcript__details-toggle-btn").exists()).toBe(true);
  });
});

describe("SessionTranscriptView pagination", () => {
  it("retries pagination for a new session after an older request settles", async () => {
    const firstPage = deferred();
    const calls: string[] = [];
    const sessionA = createSession("session-a");
    const sessionB = createSession("session-b");
    let wrapper: ReturnType<typeof mount>;
    let currentSession = sessionA;

    const loadOlderMessages = vi.fn(async () => {
      const sessionId = currentSession.sessionId;
      calls.push(sessionId);
      if (sessionId === sessionA.sessionId) {
        await firstPage.promise;
        return;
      }
      await wrapper.setProps({ session: { ...sessionB, hasMoreMessages: false } });
    });

    wrapper = mount(SessionTranscriptView, {
      props: {
        session: sessionA,
        loadOlderMessages,
      },
    });

    await vi.waitFor(() => expect(calls).toEqual([sessionA.sessionId]));
    currentSession = sessionB;
    await wrapper.setProps({ session: sessionB });
    firstPage.resolve();
    await flushPromises();

    await vi.waitFor(() => expect(calls).toEqual([sessionA.sessionId, sessionB.sessionId]));
  });
});
