import { fixture, state } from "./app-test-fixture";
import { describe, expect, it, vi } from "vite-plus/test";
import { flushPromises } from "@vue/test-utils";
import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import * as api from "@/client/lib/api";
import ChatSessionPane from "@/client/components/ChatSessionPane.vue";
import { useAppStore } from "./app";
import { applyServerEvent } from "@/client/lib/session-events";
import type { SessionState } from "@/shared/types";
import type { Draft, DraftPayload } from "@/client/lib/drafts-db";

function testComposer(restore = vi.fn()) {
  return {
    journalSubmission: async (session: string, value: DraftPayload) => ({
      tab: "test-tab",
      session,
      draft: { ...value, id: crypto.randomUUID(), createdAt: 1 },
    }),
    recoverSubmission: async (_tab: string, session: string, draft: Draft) =>
      restore(session, draft.text, draft.files, draft.retryId),
  };
}
describe("optimistic prompt reconciliation", () => {
  function mountPane() {
    const store = useAppStore();
    store.activeSession = state();
    store.connectionState = "online";
    const restore = vi.fn();
    const composer = defineComponent({
      name: "MessageComposer",
      props: ["error"],
      emits: ["submit", "removeQueuedPrompt"],
      setup(_, { expose }) {
        expose(testComposer(restore));
      },
      template: "<div>{{ error }}</div>",
    });
    fixture.wrapper = mount(ChatSessionPane, {
      global: {
        plugins: [fixture.pinia],
        config: { errorHandler: () => {} },
        stubs: { ChatHeader: true, SessionTranscriptView: true, MessageComposer: composer },
      },
    });
    const pending = () =>
      fixture.wrapper!.findComponent({ name: "SessionTranscriptView" }).props("optimisticMessages");
    return {
      store,
      restore,
      pending,
      submit: (text: string, files: File[] = []) =>
        fixture.wrapper!.findComponent(composer).vm.$emit("submit", text, files),
      removeQueued: (prompt: NonNullable<SessionState["queuedPrompts"]>[number]) =>
        fixture.wrapper!.findComponent(composer).vm.$emit("removeQueuedPrompt", prompt),
    };
  }

  it("refreshes running cron status when orchestration changes", async () => {
    const { store } = mountPane();
    await flushPromises();
    expect(api.listRunningCronRuns).toHaveBeenCalledTimes(1);
    store.orchestrationVersion++;
    await flushPromises();
    expect(api.listRunningCronRuns).toHaveBeenCalledTimes(2);
  });

  it("keeps the message after HTTP success, reset and stream state until the matching user message", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.submitMainPrompt>>) => void;
    vi.mocked(api.submitMainPrompt).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { store, pending, submit } = mountPane();
    const file = new File(["image"], "photo.png", { type: "image/png" });
    submit("Look at this", [file]);
    await flushPromises();
    expect(pending()).toHaveLength(1);
    expect(pending()[0].blocks[0].text).toContain("photo.png");
    const clientMessageId = vi.mocked(api.submitMainPrompt).mock.calls[0]![3];
    resolve({ disposition: "started", submissionId: "receipt", sessionId: "main" });
    await flushPromises();
    expect(pending()).toHaveLength(1);
    store.activeSession = applyServerEvent(store.activeSession, {
      type: "reset",
      state: state(2),
      revision: 2,
      streamId: "generation-a",
    });
    await flushPromises();
    expect(pending()).toHaveLength(1);
    store.activeSession = applyServerEvent(store.activeSession, {
      type: "state",
      state: {
        ...state(3),
        queuedPrompts: [{ kind: "followUp", index: 0, text: "Look at this", clientMessageId }],
      },
      revision: 3,
      streamId: "generation-a",
    });
    await flushPromises();
    expect(pending()).toHaveLength(0);
    store.activeSession = { ...state(4), sessionId: "other" };
    await flushPromises();
    expect(pending()).toHaveLength(0);
    store.activeSession = {
      ...state(5),
      queuedPrompts: [{ kind: "followUp", index: 0, text: "Look at this", clientMessageId }],
    };
    await flushPromises();
    expect(pending()).toHaveLength(0);
    const confirmed = {
      ...state(6),
      totalMessageCount: 1,
      messages: [
        {
          role: "user" as const,
          timestamp: 6,
          clientMessageId,
          id: "server-user",
          blocks: [{ type: "text" as const, text: "Look at this" }],
        },
      ],
    };
    store.activeSession = applyServerEvent(store.activeSession, {
      type: "reset",
      state: confirmed,
      revision: 6,
      streamId: "generation-a",
    });
    await flushPromises();
    expect(pending()).toHaveLength(0);
    expect(store.activeSession?.messages).toHaveLength(1);
  });

  it("keeps accepted queued attachments out of the transcript across reload and dispatch", async () => {
    vi.mocked(api.submitMainPrompt).mockResolvedValueOnce({
      disposition: "queued",
      submissionId: "receipt",
      sessionId: "main",
    });
    const first = mountPane();
    first.submit("Persist me", [new File(["image"], "photo.png")]);
    await flushPromises();
    const clientMessageId = vi.mocked(api.submitMainPrompt).mock.calls[0]![3];
    const prompt = {
      kind: "followUp" as const,
      index: 7,
      text: "Persist me\n\nAttached: /uploads/photo.png",
      clientMessageId,
    };
    first.store.activeSession = { ...state(2), queuedPrompts: [prompt] };
    await flushPromises();
    expect(first.pending()).toHaveLength(0);
    fixture.wrapper!.unmount();
    const second = mountPane();
    second.store.activeSession = { ...state(2), queuedPrompts: [prompt] };
    await flushPromises();
    expect(second.pending()).toHaveLength(0);
    expect(second.store.activeSession?.queuedPrompts).toEqual([prompt]);
    second.store.activeSession = {
      ...state(3),
      queuedPrompts: [],
      messages: [
        {
          role: "user",
          id: "server",
          timestamp: 3,
          clientMessageId,
          blocks: [{ type: "text", text: "Normalized" }],
        },
      ],
    };
    await flushPromises();
    expect(second.pending()).toHaveLength(0);
    expect(second.store.activeSession?.messages).toHaveLength(1);
    expect(second.store.activeSession?.queuedPrompts).toEqual([]);
  });

  it("drops interrupted prompt uploads on reload rather than reviving filenames as sent messages", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(api.submitMainPrompt).mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const first = mountPane();
    first.submit("Unsent", [new File(["image"], "photo.png")]);
    await flushPromises();
    expect(first.pending()).toHaveLength(1);
    expect(localStorage.getItem("batty:%2F:optimistic-messages")).toBeNull();
    fixture.wrapper!.unmount();
    // Discard stale entries written by the previous persisted implementation.
    localStorage.setItem(
      "batty:%2F:optimistic-messages",
      JSON.stringify({ main: first.pending() }),
    );
    const second = mountPane();
    await flushPromises();
    expect(second.pending()).toHaveLength(0);
    expect(localStorage.getItem("batty:%2F:optimistic-messages")).toBeNull();
    reject(new Error("Interrupted upload"));
    await flushPromises();
    expect(second.pending()).toHaveLength(0);
  });

  it("retires prompt optimism when another tab cancels before the HTTP response arrives", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.submitMainPrompt>>) => void;
    vi.mocked(api.submitMainPrompt).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { store, pending, submit } = mountPane();
    submit("Cancel elsewhere", []);
    await flushPromises();
    const clientMessageId = vi.mocked(api.submitMainPrompt).mock.calls[0]![3];
    store.activeSession = applyServerEvent(store.activeSession, {
      type: "state",
      state: {
        ...state(2),
        queuedPrompts: [{ kind: "followUp", index: 7, text: "Cancel elsewhere", clientMessageId }],
      },
      revision: 2,
      streamId: "generation-a",
    });
    await flushPromises();
    expect(pending()).toHaveLength(0);
    // No local remove action: cancellation arrives in an authoritative session event.
    store.activeSession = applyServerEvent(store.activeSession, {
      type: "state",
      state: state(3),
      revision: 3,
      streamId: "generation-a",
    });
    resolve({ disposition: "queued", submissionId: "receipt", sessionId: "main" });
    await flushPromises();
    expect(pending()).toHaveLength(0);
    fixture.wrapper!.unmount();
    const reloaded = mountPane();
    await flushPromises();
    expect(reloaded.pending()).toHaveLength(0);
  });

  it("resolves a prompt queue lifecycle missed by the event stream from the queued receipt snapshot", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.submitMainPrompt>>) => void;
    vi.mocked(api.submitMainPrompt).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    // Accepted and withdrawn in another tab before this tab saw the inbox.
    vi.mocked(api.getMain).mockResolvedValueOnce(state(4));
    const { pending, submit } = mountPane();
    submit("Already cancelled", []);
    await flushPromises();
    expect(pending()).toHaveLength(1);
    resolve({ disposition: "queued", submissionId: "receipt", sessionId: "main" });
    await flushPromises();
    expect(pending()).toHaveLength(0);
  });

  it("keeps an accepted queue message when only the receipt snapshot acknowledges it", async () => {
    vi.mocked(api.submitMainPrompt).mockResolvedValueOnce({
      disposition: "queued",
      submissionId: "receipt",
      sessionId: "main",
    });
    vi.mocked(api.getMain).mockImplementationOnce(async () => ({
      ...state(4),
      queuedPrompts: [
        {
          kind: "followUp",
          index: 9,
          text: "Snapshot accepted",
          clientMessageId: vi.mocked(api.submitMainPrompt).mock.calls[0]![3],
        },
      ],
    }));
    const { store, pending, submit } = mountPane();
    submit("Snapshot accepted");
    await flushPromises();
    expect(pending()).toHaveLength(0);
    expect(store.activeSession?.queuedPrompts?.[0]?.text).toBe("Snapshot accepted");
  });

  it("keeps a busy prompt only in the queue and removes a cancelled queue item", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.submitMainPrompt>>) => void;
    vi.mocked(api.submitMainPrompt).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { store, pending, submit, removeQueued } = mountPane();
    store.activeSession!.isStreaming = true;
    submit("Next instruction", []);
    await flushPromises();
    expect(api.submitMainPrompt).toHaveBeenCalledWith(
      "prompt",
      "Next instruction",
      [],
      expect.any(String),
    );
    expect(pending()).toHaveLength(0);
    const clientMessageId = vi.mocked(api.submitMainPrompt).mock.calls[0]![3];
    resolve({ disposition: "queued", submissionId: "receipt", sessionId: "main" });
    await flushPromises();
    const prompt = {
      kind: "followUp" as const,
      index: 0,
      text: "Next instruction",
      clientMessageId,
    };
    store.activeSession = { ...state(2), isStreaming: true, queuedPrompts: [prompt] };
    await flushPromises();
    expect(pending()).toHaveLength(0);
    vi.mocked(api.removeMainQueuedPrompt).mockResolvedValueOnce({
      ...state(3),
      isStreaming: true,
    });
    removeQueued(prompt);
    await flushPromises();
    expect(pending()).toHaveLength(0);
  });

  it("shows a busy prompt in the transcript only after dispatch, including reconnect", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.submitMainPrompt>>) => void;
    vi.mocked(api.submitMainPrompt).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { store, pending, submit } = mountPane();
    store.activeSession!.isStreaming = true;
    submit("Dispatch me", []);
    await flushPromises();
    expect(pending()).toHaveLength(0);
    const clientMessageId = vi.mocked(api.submitMainPrompt).mock.calls[0]![3];
    const queued = {
      ...state(2),
      isStreaming: true,
      queuedPrompts: [
        { kind: "followUp" as const, index: 0, text: "Dispatch me", clientMessageId },
      ],
    };
    vi.mocked(api.getMain).mockResolvedValueOnce(queued);
    resolve({ disposition: "queued", submissionId: "receipt", sessionId: "main" });
    await flushPromises();
    expect(pending()).toHaveLength(0);
    expect(store.activeSession?.queuedPrompts).toHaveLength(1);
    const dispatched = {
      ...state(3),
      messages: [
        {
          role: "user" as const,
          id: "server",
          timestamp: 3,
          clientMessageId,
          blocks: [{ type: "text" as const, text: "Dispatch me" }],
        },
      ],
    };
    store.activeSession = applyServerEvent(store.activeSession, {
      type: "reset",
      state: dispatched,
      revision: 3,
      streamId: "reconnected",
    });
    await flushPromises();
    expect(pending()).toHaveLength(0);
    expect(store.activeSession?.messages).toHaveLength(1);
    expect(store.activeSession?.queuedPrompts).toHaveLength(0);
  });

  it("reveals a busy submission if the server actually starts it before the event arrives", async () => {
    vi.mocked(api.submitMainPrompt).mockResolvedValueOnce({
      disposition: "started",
      submissionId: "receipt",
      sessionId: "main",
    });
    const { store, pending, submit } = mountPane();
    store.activeSession!.isStreaming = true;
    submit("Won the idle race");
    await flushPromises();
    expect(pending()).toHaveLength(1);
  });

  it("hides an idle submission queued by the server even if snapshot recovery fails", async () => {
    vi.mocked(api.submitMainPrompt).mockResolvedValueOnce({
      disposition: "queued",
      submissionId: "receipt",
      sessionId: "main",
    });
    vi.mocked(api.getMain).mockRejectedValueOnce(new Error("Snapshot unavailable"));
    const { pending, submit, restore } = mountPane();
    submit("Lost the idle race");
    await flushPromises();
    expect(pending()).toHaveLength(0);
    expect(restore).not.toHaveBeenCalled();
    expect(fixture.wrapper!.text()).toContain("Snapshot unavailable");
  });

  it("shows send errors and restores the text and attachments for retry", async () => {
    vi.mocked(api.submitMainPrompt).mockRejectedValueOnce(new Error("Upload failed"));
    const { pending, restore, submit } = mountPane();
    const files = [new File(["data"], "report.txt")];
    submit("Keep this", files);
    await flushPromises();
    expect(pending()).toHaveLength(0);
    expect(restore).toHaveBeenCalledWith("main", "Keep this", files, expect.any(String));
    expect(fixture.wrapper!.text()).toContain("Upload failed");
  });
});

describe("restored prompt submission", () => {
  it("does not restore an accepted prompt draft when its HTTP response is lost", async () => {
    const store = useAppStore();
    store.activeSession = state();
    store.connectionState = "online";
    const restore = vi.fn();
    const handleError = vi.fn();
    const composer = defineComponent({
      name: "MessageComposer",
      emits: ["submit"],
      setup(_, { expose }) {
        expose(testComposer(restore));
      },
      template: "<div />",
    });
    vi.mocked(api.submitMainPrompt).mockImplementationOnce(
      async (_kind, _text, _files, clientMessageId) => {
        store.activeSession = {
          ...state(2),
          queuedPrompts: [{ kind: "followUp", index: 0, text: "Accepted", clientMessageId }],
        };
        throw new TypeError("Lost response after acceptance");
      },
    );
    fixture.wrapper = mount(ChatSessionPane, {
      global: {
        plugins: [fixture.pinia],
        config: { errorHandler: handleError },
        stubs: { ChatHeader: true, SessionTranscriptView: true, MessageComposer: composer },
      },
    });
    fixture.wrapper.findComponent(composer).vm.$emit("submit", "Accepted", []);
    await flushPromises();
    expect(restore).not.toHaveBeenCalled();
    expect(handleError).not.toHaveBeenCalled();
  });
  it("retries a transport-failed prompt with the original clientMessageId", async () => {
    const store = useAppStore();
    store.activeSession = state();
    store.connectionState = "online";
    vi.mocked(api.submitMainPrompt)
      .mockRejectedValueOnce(new TypeError("Lost response"))
      .mockResolvedValueOnce({
        disposition: "started",
        submissionId: "receipt",
        sessionId: "main",
      });
    const restore = vi.fn();
    const composer = defineComponent({
      name: "MessageComposer",
      emits: ["submit"],
      setup(_, { expose }) {
        expose(testComposer(restore));
      },
      template: "<div />",
    });
    fixture.wrapper = mount(ChatSessionPane, {
      global: {
        plugins: [fixture.pinia],
        config: { errorHandler: () => {} },
        stubs: { ChatHeader: true, SessionTranscriptView: true, MessageComposer: composer },
      },
    });
    const child = fixture.wrapper.findComponent(composer);
    child.vm.$emit("submit", "Only once", []);
    await flushPromises();
    const originalId = vi.mocked(api.submitMainPrompt).mock.calls[0]![3];
    expect(restore).toHaveBeenCalledWith("main", "Only once", [], originalId);
    child.vm.$emit("submit", "Only once", restore.mock.calls[0]![2], restore.mock.calls[0]![3]);
    await flushPromises();
    expect(api.submitMainPrompt).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.submitMainPrompt).mock.calls[1]![3]).toBe(originalId);
  });
});
