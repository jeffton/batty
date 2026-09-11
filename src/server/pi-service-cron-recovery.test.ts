import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context, getOrThrow } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createHarnessFixture } from "./harness-test-fixture";
import { executeCronOperation, recoverCronJobSession } from "./pi-service-cron-adapter";
import { buildCronRuntimeNotice } from "./runtime-notices";
import { buildCronRunSessionBinding, CRON_RUN_SESSION_CUSTOM_TYPE } from "./cron-session";
import type { WebSession } from "./pi-service-types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const notice = buildCronRuntimeNotice({
  scheduleLabel: "Every hour",
  prompt: "Heartbeat",
  session: { kind: "new" },
});

describe("native cron operation recovery", () => {
  it("rejoins admission and reads the same terminal result without submitting another prompt", async () => {
    const fixture = await createHarnessFixture();
    cleanups.push(fixture.cleanup);
    getOrThrow(
      await fixture.session.lane.accept(
        { kind: "prompt", operationId: "cron-run", prompt: "Heartbeat" },
        context,
      ),
    );
    await fixture.reopen();
    fixture.faux.setResponses([fauxAssistantMessage("done")]);
    await executeCronOperation(fixture.session, notice, "cron-run", true);
    await fixture.reopen();
    await executeCronOperation(fixture.session, notice, "cron-run", true);
    expect(fixture.faux.state.callCount).toBe(1);
    expect(fixture.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("does not admit an unstarted run during recovery or drive a later inline operation", async () => {
    const fixture = await createHarnessFixture();
    cleanups.push(fixture.cleanup);
    await expect(executeCronOperation(fixture.session, notice, "unstarted", true)).rejects.toThrow(
      "before this cron operation was admitted",
    );
    fixture.faux.setResponses([fauxAssistantMessage("first completed")]);
    await executeCronOperation(fixture.session, notice, "first");
    getOrThrow(
      await fixture.session.lane.accept(
        { kind: "prompt", operationId: "second", prompt: "Later user turn" },
        context,
      ),
    );
    await executeCronOperation(fixture.session, notice, "first", true);
    expect((await fixture.session.lane.inspectExecution(context)).current?.id).toBe("second");
    expect(fixture.faux.state.callCount).toBe(1);
  });

  it.each(["failed", "aborted"] as const)("reports a durable %s operation", async (status) => {
    const fixture = await createHarnessFixture({
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    });
    cleanups.push(fixture.cleanup);
    getOrThrow(
      await fixture.session.lane.accept(
        { kind: "prompt", operationId: "cron-run", prompt: "Heartbeat" },
        context,
      ),
    );
    if (status === "aborted") await fixture.session.lane.requestAbort("cron-run", context);
    else
      fixture.faux.setResponses([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider refused" }),
      ]);
    await fixture.reopen();
    await expect(executeCronOperation(fixture.session, notice, "cron-run", true)).rejects.toThrow();
    expect((await fixture.session.lane.getResult("cron-run", context))?.status).toBe(status);
    const calls = fixture.faux.state.callCount;
    await fixture.reopen();
    await expect(executeCronOperation(fixture.session, notice, "cron-run", true)).rejects.toThrow();
    expect(fixture.faux.state.callCount).toBe(calls);
  });

  it.each(["Delivered answer", "NO_REPLY"])(
    "queues recovered detached completion %s for its original parent",
    async (answer) => {
      const child = await createHarnessFixture();
      const parent = await createHarnessFixture();
      cleanups.push(child.cleanup, parent.cleanup);
      const workspace = {
        id: "test",
        label: "Test",
        path: child.root,
        kind: "workspace" as const,
        isPinned: false,
        isAssistant: false,
      };
      await child.session.sessionManager.appendCustomEntry(
        CRON_RUN_SESSION_CUSTOM_TYPE,
        buildCronRunSessionBinding({
          jobId: "job",
          runId: "run",
          parentSessionId: parent.session.sessionId,
        }),
      );
      getOrThrow(
        await child.session.lane.accept(
          { kind: "prompt", operationId: "run", prompt: "Heartbeat" },
          context,
        ),
      );
      await child.reopen();
      child.faux.setResponses([fauxAssistantMessage(answer)]);
      const openParent = vi.fn(async () => ({ id: parent.session.sessionId }) as never);
      const notify = vi.fn(async () => undefined);
      const adapter = {
        createCronSession: vi.fn(),
        promptCron: vi.fn(),
        resolveOrCreateDailySession: vi.fn(),
        openSession: async () => ({ id: child.session.sessionId }) as never,
        openSessionById: openParent,
        requireSession: (id: string) =>
          ({
            id,
            workspace,
            session: id === child.session.sessionId ? child.session : parent.session,
          }) as WebSession,
        requireSessionPath: vi.fn(),
        prepareSessionForContextCopy: vi.fn(),
        runSubagentSerial: async <T>(_id: string, run: () => Promise<T>) => run(),
        getState: vi.fn(() => ({}) as never),
        publishReset: vi.fn(),
        setThinkingLevel: vi.fn(),
        setModel: vi.fn(),
        notifyWorkspaceUpdated: vi.fn(),
        onAgentCompleted: notify,
      };
      const run = {
        jobId: "job",
        runId: "run",
        workspace,
        prompt: "Heartbeat",
        model: "faux/faux-1",
        thinkingLevel: "off",
        session: { kind: "daily-detached" as const },
        scheduleLabel: "Every hour",
        startedAtMs: 1,
        sessionPath: child.session.sessionFile,
        signal: new AbortController().signal,
        onSessionStarted: vi.fn(),
        queueResultDelivery: vi.fn(async () => undefined),
      };
      await recoverCronJobSession(adapter, run);
      await child.reopen();
      await parent.reopen();
      await recoverCronJobSession(adapter, run);
      expect(openParent).not.toHaveBeenCalled();
      expect(run.queueResultDelivery).toHaveBeenCalledTimes(answer === "NO_REPLY" ? 0 : 2);
      if (answer !== "NO_REPLY") {
        expect(run.queueResultDelivery).toHaveBeenCalledWith(parent.session.sessionId);
      }
      expect(adapter.resolveOrCreateDailySession).not.toHaveBeenCalled();
      expect(adapter.promptCron).not.toHaveBeenCalled();
      expect(parent.session.messages).toHaveLength(0);
      expect(notify).not.toHaveBeenCalled();
      expect(child.faux.state.callCount).toBe(1);
    },
  );
});
