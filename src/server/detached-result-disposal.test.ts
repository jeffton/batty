import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SessionState, WorkspaceInfo } from "@/shared/types";
import type { AgentSessionController } from "./agent-session-controller";
import { createAgentSessionFixture } from "./agent-session-test-fixture";
import { createPiAgentSession } from "./pi-agent-session";
import { attachSession, disposeWebSession } from "./pi-service-sessions";
import { handleSessionEvent } from "./pi-service-agent-events";
import type { WebSession } from "./pi-service-types";
import {
  deliverCronJobRun,
  executeCronOperation,
  getCronExecutionResult,
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

function conversationalMessages<T extends { role: string }>(messages: T[]): T[] {
  return messages.filter((message) => message.role !== "system");
}

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
    attach: (session: AgentSessionController) =>
      attachSession(
        sessions,
        vi.fn(),
        (webSession, event) =>
          handleSessionEvent(
            {
              getState: state,
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
  const parent = await createAgentSessionFixture();
  const workspace: WorkspaceInfo = {
    id: "test",
    path: parent.root,
    label: "Test",
    kind: "workspace",
    isPinned: false,
    isAssistant: false,
  };
  let finishParent!: () => void;
  const response = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
    finishParent = () => resolve(fauxAssistantMessage("Parent answer"));
  });
  parent.faux.setResponses([async () => response]);
  const parentTurn = parent.session.prompt("Busy parent turn");
  cleanups.unshift(async () => {
    finishParent();
    await parentTurn;
  });
  cleanups.push(parent.cleanup);
  await vi.waitFor(() => expect(parent.session.isStreaming).toBe(true));
  return { parent, workspace, parentTurn, finishParent };
}

describe("detached result delivery after ephemeral session disposal", () => {
  it.each(["fresh", "disposed-before-return", "failed", "recovered-failed", "NO_REPLY"])(
    "preserves a %s cron result while its parent is busy",
    async (mode) => {
      const { parent, workspace, parentTurn, finishParent } = await busyParent();
      const failed = mode === "failed" || mode === "recovered-failed";
      const child = await createAgentSessionFixture({
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
        failed
          ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider refused" })
          : fauxAssistantMessage(mode === "NO_REPLY" ? "NO_REPLY" : "Child answer"),
      ]);
      const queues = new Map<string, Promise<void>>();
      const adapter: PiServiceCronAdapterContext = {
        openSession: async () => lifecycle.state(childId),
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
        requireSessionPath: (id) => {
          expect(lifecycle.sessions.has(id)).toBe(true);
          return childPath;
        },
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
        ...(mode === "recovered-failed"
          ? {
              recovery: {
                jobId: "job",
                runId: "run",
                workspaceId: workspace.id,
                prompt: "Heartbeat",
                model: "faux/faux-1",
                thinkingLevel: "off",
                session: { kind: "daily-detached" as const },
                scheduleLabel: "Every hour",
                startedAtMs: 1,
                status: "running" as const,
                sessionId: childId,
                sessionPath: childPath,
              },
            }
          : {}),
      };
      const running = runCronJobSession(adapter, job);
      // Observe rejection immediately so a regression cannot escape as an unhandled rejection.
      const outcome = running.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await vi.waitFor(() => expect(lifecycle.unregistered).toHaveBeenCalledWith(childId));
      expect(parent.session.isStreaming).toBe(true);
      expect(child.session.isClosing).toBe(true);
      expect(conversationalMessages(parent.session.messages)).toHaveLength(1);
      expect(getCronExecutionResult(child.session, "run")?.status).toBe(
        failed ? "failed" : "completed",
      );
      expect(await outcome).toEqual(
        failed
          ? { error: expect.objectContaining({ message: "provider refused" }) }
          : { result: { sessionId: childId, sessionPath: childPath } },
      );
      expect(job.queueResultDelivery).toHaveBeenCalledTimes(mode === "NO_REPLY" ? 0 : 1);
      if (mode !== "NO_REPLY") {
        expect(job.queueResultDelivery).toHaveBeenCalledWith(parent.session.sessionId);
      }
      expect(queues.size).toBe(0);
      finishParent();
      await parentTurn;
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
            status: failed ? "error" : "success",
            sessionId: childId,
            sessionPath: childPath,
            ...(failed ? { error: "provider refused" } : {}),
          },
          { parentSessionId: parent.session.sessionId, queuedAtMs: 2 },
        );
        await vi.waitFor(() => expect(lifecycle.sessions.has(childId)).toBe(false));
      }
      await parent.reopen();
      expect(conversationalMessages(parent.session.messages)).toHaveLength(
        mode === "NO_REPLY" ? 2 : 4,
      );
      if (mode !== "NO_REPLY") {
        expect(parent.session.messages.at(-1)).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: failed ? "provider refused" : "Child answer" }],
          stopReason: failed ? "error" : "stop",
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
    const { parent, workspace, parentTurn, finishParent } = await busyParent();
    const lifecycle = completionLifecycle(workspace);
    let child!: AgentSessionController;
    cleanups.push(async () => {
      await child?.dispose();
    });
    const delivering = vi.fn();
    parent.faux.setResponses([fauxAssistantMessage("Child answer")]);
    const running = runDetachedSubagentSession(
      {
        workspaceSessionDir: path.join(parent.root, "sessions"),
        createPiAgentSession: async (_workspace, store) => {
          ({ session: child } = await createPiAgentSession({
            config: parent.config,
            workspace,
            sessionManager: store,
            modelRuntime: parent.modelRuntime,
            customTools: [],
            model: parent.faux.getModel(),
          }));
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
        includePreviousContext: false,
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
    expect(child.messages.at(-1)).toMatchObject({ role: "assistant" });
    finishParent();
    await parentTurn;
    expect(await outcome).toMatchObject({ result: { text: "Child answer", isError: false } });
    await parent.reopen();
    expect(conversationalMessages(parent.session.messages)).toHaveLength(4);
    expect(parent.session.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Child answer" }],
      stopReason: "stop",
    });
  });
});
