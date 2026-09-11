import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BACKGROUND_CONTEXT as context,
  getOrThrow,
  HarnessClosed,
} from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SessionState, WorkspaceInfo } from "@/shared/types";
import { HarnessController } from "./harness-controller";
import { createHarnessFixture } from "./harness-test-fixture";
import { attachSession, disposeWebSession, handleAgentEvent } from "./pi-service-sessions";
import type { WebSession } from "./pi-service-types";
import {
  deliverCronJobRun,
  executeCronOperation,
  recoverCronJobSession,
  runCronJobSession,
  type PiServiceCronAdapterContext,
} from "./pi-service-cron-adapter";
import { buildCronRunSessionBinding, CRON_RUN_SESSION_CUSTOM_TYPE } from "./cron-session";
import {
  deliverDetachedSubagentResult,
  runDetachedSubagentSession,
  runSubagentSerial,
} from "./pi-service-subagents";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function completionLifecycle(workspace: WorkspaceInfo) {
  const sessions = new Map<string, WebSession>();
  const unregistered = vi.fn();
  const dispose = (session: WebSession) => disposeWebSession(sessions, unregistered, session);
  const state = (id: string) =>
    ({ id, sessionId: id, workspaceId: workspace.id, messages: [] }) as unknown as SessionState;
  return {
    sessions,
    state,
    dispose,
    unregistered,
    attach: (session: HarnessController) =>
      attachSession(
        sessions,
        vi.fn(),
        (webSession, event) =>
          handleAgentEvent(
            {
              getState: state,
              getStateMetadata: (web) => state(web.id),
              publish: vi.fn(),
              notifyWorkspaceUpdated: async () => undefined,
              disposeWebSession: dispose,
            },
            webSession,
            event,
          ),
        workspace,
        session,
        undefined,
        true,
      ),
  };
}

async function busyParent() {
  const parent = await createHarnessFixture();
  cleanups.push(parent.cleanup);
  const workspace: WorkspaceInfo = {
    id: "test",
    path: parent.root,
    label: "Test",
    kind: "workspace",
    isPinned: false,
    isAssistant: false,
  };
  getOrThrow(
    await parent.session.lane.accept(
      { kind: "prompt", prompt: "Busy parent turn", operationId: "parent-turn" },
      context,
    ),
  );
  parent.faux.setResponses([fauxAssistantMessage("Parent answer")]);
  return { parent, workspace };
}

describe("detached result delivery after ephemeral harness disposal", () => {
  it.each(["fresh", "recovered", "disposed-before-return", "failed", "NO_REPLY"])(
    "preserves a %s cron result while its parent is busy",
    async (mode) => {
      const { parent, workspace } = await busyParent();
      const child = await createHarnessFixture({
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
      });
      cleanups.push(child.cleanup);
      const lifecycle = completionLifecycle(workspace);
      let webChild = lifecycle.attach(child.session);
      const childId = child.session.sessionId;
      const childPath = child.session.sessionFile;
      await child.session.sessionManager.appendCustomEntry(
        CRON_RUN_SESSION_CUSTOM_TYPE,
        buildCronRunSessionBinding({
          jobId: "job",
          runId: "run",
          parentSessionId: parent.session.sessionId,
        }),
      );
      child.faux.setResponses([
        mode === "failed"
          ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider refused" })
          : fauxAssistantMessage(mode === "NO_REPLY" ? "NO_REPLY" : "Child answer"),
      ]);
      const queues = new Map<string, Promise<void>>();
      const adapter: PiServiceCronAdapterContext = {
        createCronSession: async () => lifecycle.state(childId),
        promptCron: async (_id, notice, operationId) => {
          await executeCronOperation(child.session, notice, operationId);
          if (mode === "disposed-before-return") {
            await vi.waitFor(() => expect(lifecycle.sessions.has(childId)).toBe(false));
          }
        },
        resolveOrCreateDailySession: async () => lifecycle.state(parent.session.sessionId),
        requireSession: (id) =>
          id === childId ? webChild : ({ id, workspace, session: parent.session } as WebSession),
        requireSessionPath: () => childPath,
        prepareSessionForContextCopy: vi.fn(),
        runSubagentSerial: (id, run) => runSubagentSerial(queues, id, run),
        getState: lifecycle.state,
        publishReset: vi.fn(),
        setThinkingLevel: vi.fn(),
        setModel: vi.fn(),
        onAgentCompleted: vi.fn(),
        notifyWorkspaceUpdated: vi.fn(),
      };
      const job = {
        jobId: "job",
        runId: "run",
        workspace,
        prompt: "Heartbeat",
        model: "faux/faux-1",
        thinkingLevel: "off",
        session: { kind: "daily-detached" as const },
        scheduleLabel: "Every hour",
        signal: new AbortController().signal,
        onSessionStarted: vi.fn(),
        queueResultDelivery: vi.fn(async () => undefined),
      };
      if (mode === "recovered") {
        getOrThrow(
          await child.session.lane.accept(
            { kind: "prompt", prompt: job.prompt, operationId: job.runId },
            context,
          ),
        );
      }
      const running =
        mode === "recovered"
          ? recoverCronJobSession(
              {
                ...adapter,
                openSession: async () => lifecycle.state(childId),
              },
              { ...job, sessionPath: childPath, startedAtMs: 1 },
            )
          : runCronJobSession(adapter, job);
      // Observe rejection immediately so a regression cannot escape as an unhandled rejection.
      const outcome = running.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await vi.waitFor(() => expect(lifecycle.unregistered).toHaveBeenCalledWith(childId));
      expect(parent.session.isStreaming).toBe(true);
      expect(parent.session.messages).toHaveLength(1);
      await expect(child.session.lane.getResult("run", context)).rejects.toBeInstanceOf(
        HarnessClosed,
      );
      expect(child.session.snapshot.lastResult?.status).toBe(
        mode === "failed" ? "failed" : "completed",
      );
      expect(await outcome).toEqual(
        mode === "failed"
          ? { error: expect.objectContaining({ message: "provider refused" }) }
          : { result: { sessionId: childId, sessionPath: childPath } },
      );
      expect(job.queueResultDelivery).toHaveBeenCalledTimes(mode === "NO_REPLY" ? 0 : 1);
      if (mode !== "NO_REPLY") {
        expect(job.queueResultDelivery).toHaveBeenCalledWith(parent.session.sessionId);
      }
      expect(queues.size).toBe(0);
      await parent.session.resume();
      if (mode !== "NO_REPLY") {
        await deliverCronJobRun(
          {
            ...adapter,
            openSessionForDelivery: async () => {
              await child.reopen();
              webChild = lifecycle.attach(child.session);
              return { state: lifecycle.state(childId), owned: true };
            },
            openSessionById: async () => lifecycle.state(parent.session.sessionId),
            disposeSession: (id) => lifecycle.dispose(adapter.requireSession(id)),
          },
          {
            jobId: job.jobId,
            runId: job.runId,
            workspaceId: workspace.id,
            workspace,
            prompt: job.prompt,
            model: job.model,
            thinkingLevel: job.thinkingLevel,
            session: job.session,
            scheduleLabel: job.scheduleLabel,
            startedAtMs: 1,
            status: mode === "failed" ? "error" : "success",
            sessionId: childId,
            sessionPath: childPath,
            ...(mode === "failed" ? { error: "provider refused" } : {}),
          },
          { parentSessionId: parent.session.sessionId, queuedAtMs: 2 },
        );
        expect(lifecycle.sessions.has(childId)).toBe(false);
      }
      await parent.reopen();
      expect(parent.session.messages).toHaveLength(mode === "NO_REPLY" ? 2 : 4);
      if (mode !== "NO_REPLY") {
        expect(parent.session.messages.at(-1)).toMatchObject({
          role: "assistant",
          content: [
            { type: "text", text: mode === "failed" ? "provider refused" : "Child answer" },
          ],
          stopReason: mode === "failed" ? "error" : "stop",
        });
        expect(adapter.onAgentCompleted).toHaveBeenCalledTimes(1);
      } else {
        expect(adapter.onAgentCompleted).not.toHaveBeenCalled();
      }
      expect(child.faux.state.callCount).toBe(1);
      expect(queues.size).toBe(0);
    },
  );

  it("delivers a captured subagent result after completion closes the child while its parent is busy", async () => {
    const { parent, workspace } = await busyParent();
    const lifecycle = completionLifecycle(workspace);
    let child!: HarnessController;
    cleanups.unshift(async () => {
      await child?.dispose();
    });
    const delivering = vi.fn();
    // This provider is shared by child and parent; the child runs first.
    parent.faux.setResponses([
      fauxAssistantMessage("Child answer"),
      fauxAssistantMessage("Parent answer"),
    ]);
    const running = runDetachedSubagentSession(
      {
        workspaceSessionDir: path.join(parent.root, "sessions"),
        createPiAgentSession: async (_workspace, store) => {
          child = await HarnessController.create(
            store,
            {
              models: parent.models,
              model: parent.faux.getModel(),
              compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
            },
            SettingsManager.inMemory(),
            new DefaultResourceLoader({ cwd: parent.root, agentDir: parent.root }),
          );
          return { session: child };
        },
        attachSession: (_workspace, session) => lifecycle.attach(session),
        disposeWebSession: lifecycle.dispose,
        deliverResultToParent: async (_options, result) => {
          delivering();
          await parent.session.waitForIdle();
          await deliverDetachedSubagentResult(parent.session, result);
        },
      },
      {
        workspace,
        parentSessionId: parent.session.sessionId,
        parentSubagentDepth: 0,
        prompt: "Child work",
        modelId: "faux/faux-1",
        thinkingLevel: "off",
        includeSessionContext: false,
        respondIn: "session",
      },
    );
    const outcome = running.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await vi.waitFor(() => expect(lifecycle.unregistered).toHaveBeenCalledTimes(1));
    expect(delivering).toHaveBeenCalledTimes(1);
    expect(parent.session.isStreaming).toBe(true);
    await expect(
      child.lane.getResult(child.snapshot.lastResult!.operationId, context),
    ).rejects.toBeInstanceOf(HarnessClosed);
    await parent.session.resume();
    expect(await outcome).toMatchObject({ result: { text: "Child answer", isError: false } });
    await parent.reopen();
    expect(parent.session.messages).toHaveLength(4);
    expect(parent.session.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Child answer" }],
      stopReason: "stop",
    });
  });
});
