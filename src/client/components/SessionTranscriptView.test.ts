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
