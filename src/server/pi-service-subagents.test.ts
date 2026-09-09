import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { HarnessController } from "./harness-controller";
import {
  runDetachedSubagentSession,
  deliverDetachedSubagentResult,
  findDetachedSubagentDeliveryRequest,
  runSubagentSerial,
  type RunDetachedSubagentDeps,
  type DetachedSubagentOptions,
} from "./pi-service-subagents";
import { createHarnessFixture } from "./harness-test-fixture";
import { BATTY_SYSTEM_PROMPT_CUSTOM_TYPE } from "./batty-system-prompt";
import type { WebSession } from "./pi-service-types";
import { buildRuntimeNoticeMessage, buildSubagentRuntimeNotice } from "./runtime-notices";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const parent = await createHarnessFixture();
  const children = new Map<string, HarnessController>();
  cleanups.push(async () => {
    for (const child of children.values()) await child.dispose();
    await parent.cleanup();
  });
  const workspace = {
    id: "test",
    path: parent.root,
    label: "Test",
    kind: "workspace" as const,
    isPinned: false,
    isAssistant: false,
  };
  const deps: RunDetachedSubagentDeps = {
    workspaceSessionDir: path.join(parent.root, "sessions"),
    async createPiAgentSession(_workspace, store) {
      let session = children.get(store.getSessionId());
      if (!session) {
        session = await HarnessController.create(
          store,
          {
            models: parent.models,
            model: parent.faux.getModel(),
            compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
            retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
          },
          SettingsManager.inMemory(),
          new DefaultResourceLoader({ cwd: parent.root, agentDir: parent.root }),
        );
        children.set(session.sessionId, session);
      }
      return { session };
    },
    attachSession(workspace, session) {
      return {
        id: session.sessionId,
        workspace,
        session,
        subscribers: new Set(),
        activeTools: new Map(),
        openedAt: 0,
        ephemeral: true,
      } as WebSession;
    },
    disposeWebSession: vi.fn(),
  };
  const options: DetachedSubagentOptions = {
    sessionId: parent.session.sessionManager.native.idGenerator.next(),
    workspace,
    parentSessionId: parent.session.sessionId,
    parentSessionPath: parent.session.sessionFile,
    parentSubagentDepth: 0,
    prompt: "Child work",
    modelId: "faux/faux-1",
    thinkingLevel: "off",
    includeSessionContext: false,
    respondIn: "tool-call",
  };
  return { parent, children, deps, options };
}

describe("detached harness subagents", () => {
  it.each([false, true])(
    "sends the task only in a runtime notice with includeSessionContext=%s",
    async (includeSessionContext) => {
      const { parent, deps, options } = await setup();
      parent.faux.setResponses([fauxAssistantMessage("done")]);
      const result = await runDetachedSubagentSession(deps, {
        ...options,
        includeSessionContext,
      });
      expect(result.isError).toBe(false);
      expect(result.generatedMessages).toEqual([
        expect.objectContaining({
          role: "custom",
          customType: "batty-runtime-notice:subagent",
          content: buildSubagentRuntimeNotice(1, options.prompt).text,
        }),
        expect.objectContaining({ role: "assistant" }),
      ]);
    },
  );
  it("forks before the invoking tool call and preserves the prompt snapshot", async () => {
    const { parent, deps, options, children } = await setup();
    await parent.session.sessionManager.appendCustomEntry("batty-subagent-session", {
      parentSessionId: "grandparent",
      depth: 1,
    });
    await parent.session.sessionManager.appendCustomEntry(BATTY_SYSTEM_PROMPT_CUSTOM_TYPE, {
      appendedPrompt: "parent prompt",
    });
    await parent.session.lane.appendMessage(
      { role: "user", content: "parent question", timestamp: 1 },
      context,
    );
    await parent.session.lane.appendMessage(fauxAssistantMessage("parent answer"), context);
    await parent.session.lane.appendMessage(
      fauxAssistantMessage([
        { type: "toolCall", id: "invoke-child", name: "subagent", arguments: {} },
      ]),
      context,
    );
    await parent.session.lane.appendCustomEntry("sibling-tool-metadata", {}, context);
    parent.faux.setResponses([fauxAssistantMessage("child answer")]);
    const result = await runDetachedSubagentSession(deps, {
      ...options,
      includeSessionContext: true,
      currentToolCallId: "invoke-child",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toBe("child answer");
    const child = children.get(options.sessionId!)!;
    expect(child.messages).toContainEqual(
      expect.objectContaining({ role: "user", content: "parent question" }),
    );
    expect(JSON.stringify(child.messages)).not.toContain("invoke-child");
    expect(child.sessionManager.native.metadata.parentSessionId).toBe(parent.session.sessionId);
    expect(
      child.sessionManager
        .getEntries()
        .findLast(
          (entry) => entry.type === "custom" && entry.customType === "batty-subagent-session",
        ),
    ).toMatchObject({ data: { parentSessionId: parent.session.sessionId } });
    expect(child.sessionManager.getEntries()).toContainEqual(
      expect.objectContaining({
        customType: BATTY_SYSTEM_PROMPT_CUSTOM_TYPE,
        data: { appendedPrompt: "parent prompt" },
      }),
    );
  });

  it.each([false, true])(
    "persists depth for nested children with includeSessionContext=%s",
    async (includeSessionContext) => {
      const { parent, deps, options, children } = await setup();
      await parent.session.sessionManager.appendCustomEntry("batty-subagent-session", {
        parentSessionId: "root",
        depth: 1,
      });
      parent.faux.setResponses([fauxAssistantMessage("done")]);

      await runDetachedSubagentSession(deps, {
        ...options,
        parentSubagentDepth: 1,
        includeSessionContext,
      });

      expect(
        children
          .get(options.sessionId!)!
          .sessionManager.getEntries()
          .findLast(
            (entry) => entry.type === "custom" && entry.customType === "batty-subagent-session",
          ),
      ).toMatchObject({ data: { parentSessionId: parent.session.sessionId, depth: 2 } });
    },
  );

  it("publishes the durable child identity before streaming text", async () => {
    const { parent, deps, options } = await setup();
    const updates: unknown[] = [];
    parent.faux.setResponses([fauxAssistantMessage("done")]);
    const result = await runDetachedSubagentSession(deps, {
      ...options,
      onUpdate: (update) => updates.push(update),
    });
    expect(updates[0]).toMatchObject({
      content: [],
      details: { subagent: { sessionId: options.sessionId, sessionPath: expect.any(String) } },
    });
    expect(result.text).toBe("done");
  });

  it("reuses a terminal child on replay without repeating its prompt or provider effect", async () => {
    const { parent, deps, options, children } = await setup();
    parent.faux.setResponses([fauxAssistantMessage("once")]);
    const first = await runDetachedSubagentSession(deps, options);
    await children.get(options.sessionId!)!.dispose();
    children.delete(options.sessionId!);
    const replayed = await runDetachedSubagentSession(deps, options);
    expect(replayed.text).toBe(first.text);
    expect(parent.faux.state.callCount).toBe(1);
    expect(replayed.generatedMessages.filter((message) => message.role === "user")).toHaveLength(0);
    expect(replayed.generatedMessages.filter((message) => message.role === "custom")).toHaveLength(
      1,
    );
  });

  it("resumes an admitted child operation after reopening without repeating the child prompt", async () => {
    const { parent, deps, options, children } = await setup();
    // Persist the invocation-owned child and its request before operation admission.
    await runDetachedSubagentSession(deps, {
      ...options,
      signal: AbortSignal.abort(new Error("not started")),
    });
    const child = children.get(options.sessionId!)!;
    const admission = await child.lane.accept(
      {
        kind: "prompt",
        prompt: buildRuntimeNoticeMessage(
          buildSubagentRuntimeNotice(1, options.prompt),
          Date.now(),
        ),
      },
      context,
    );
    expect(admission.ok).toBe(true);
    await child.dispose();
    children.delete(child.sessionId);
    parent.faux.setResponses([fauxAssistantMessage("recovered child")]);
    const result = await runDetachedSubagentSession(deps, options);
    expect(result.text).toBe("recovered child");
    expect(result.generatedMessages.filter((message) => message.role === "user")).toHaveLength(0);
    expect(result.generatedMessages.filter((message) => message.role === "custom")).toHaveLength(1);
    expect(parent.faux.state.callCount).toBe(1);
  });

  it("reports durable provider failure to the parent", async () => {
    const { parent, deps, options } = await setup();
    parent.faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider rejected" }),
    ]);
    const result = await runDetachedSubagentSession(deps, options);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain("provider rejected");
  });

  it.each(["Parent result", "NO_REPLY"])(
    "durably delivers detached session result %s once across replay",
    async (answer) => {
      const { parent, deps, options, children } = await setup();
      parent.faux.setResponses([fauxAssistantMessage(answer)]);
      const queues = new Map<string, Promise<void>>();
      const delivered = vi.fn(async (request, result) =>
        runSubagentSerial(queues, request.parentSessionId, () =>
          deliverDetachedSubagentResult(parent.session, result),
        ),
      );
      deps.deliverResultToParent = async (request, result) => {
        await delivered(request, result);
      };
      const request = { ...options, respondIn: "session" as const };
      await runDetachedSubagentSession(deps, request);
      const child = children.get(options.sessionId!)!;
      const recovery = findDetachedSubagentDeliveryRequest(
        child.sessionManager.getEntries(),
        child.sessionId,
      )!;
      expect(recovery.parentSessionId).toBe(parent.session.sessionId);
      expect(
        findDetachedSubagentDeliveryRequest(child.sessionManager.getEntries(), "forked-child"),
      ).toBeUndefined();
      await child.dispose();
      children.delete(child.sessionId);
      await parent.reopen();
      await runDetachedSubagentSession(deps, { ...recovery, sessionId: options.sessionId });
      expect(parent.faux.state.callCount).toBe(1);
      expect(parent.session.messages).toHaveLength(answer === "NO_REPLY" ? 0 : 2);
      expect(queues.size).toBe(0);
    },
  );

  it("retries a failed parent delivery without rerunning the child", async () => {
    const { parent, deps, options, children } = await setup();
    parent.faux.setResponses([fauxAssistantMessage("finished child")]);
    const request = { ...options, respondIn: "session" as const };
    deps.deliverResultToParent = vi.fn(async () => {
      throw new Error("parent unavailable");
    });
    await expect(runDetachedSubagentSession(deps, request)).rejects.toThrow("parent unavailable");
    const child = children.get(options.sessionId!)!;
    expect(child.snapshot.lastResult?.status).toBe("completed");
    await child.dispose();
    children.delete(child.sessionId);
    deps.deliverResultToParent = async (_request, result) => {
      await deliverDetachedSubagentResult(parent.session, result);
    };
    await runDetachedSubagentSession(deps, request);
    expect(parent.faux.state.callCount).toBe(1);
    expect(parent.session.messages).toHaveLength(2);
  });

  it("does not execute a child that was cancelled before admission", async () => {
    const { parent, deps, options } = await setup();
    const signal = AbortSignal.abort(new Error("cancelled"));
    const result = await runDetachedSubagentSession(deps, { ...options, signal });
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain("cancelled");
    expect(parent.faux.state.callCount).toBe(0);
    await expect(
      runDetachedSubagentSession(deps, { ...options, recoverOnly: true }),
    ).rejects.toThrow("before this subagent operation was admitted");
    expect(parent.faux.state.callCount).toBe(0);
  });
});
