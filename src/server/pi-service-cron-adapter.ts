import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as nativeContext, getOrThrow } from "@earendil-works/pi-agent-core";
import { CRON_RUN_SESSION_CUSTOM_TYPE, type CronRunSessionBinding } from "./cron-session";
import { appendResultDelivery } from "./session-result-delivery";
import type { HarnessController as AgentSession } from "./harness-controller";
import type {
  CronJobSession,
  CronRunLog,
  PendingCronRunDelivery,
  RunningCronJob,
  SessionState,
  WorkspaceInfo,
} from "@/shared/types";
import { buildCronRuntimeNotice, type RuntimeNotice } from "./runtime-notices";
import type { WebSession } from "./pi-service-types";
import { extractAssistantText, stripThinkingFromAssistantMessage, ZERO_USAGE } from "./subagent";
import { agentTurnFileChangesByReplyEntryId } from "./agent-turn-file-changes";
import type { AgentTurnFileChange } from "@/shared/types";

export type CronJobRun = {
  jobId: string;
  runId: string;
  workspace: WorkspaceInfo;
  prompt: string;
  model: string;
  thinkingLevel: string;
  session: CronJobSession;
  scheduleLabel: string;
  signal: AbortSignal;
  onSessionStarted(session: { sessionId: string; sessionPath: string }): void | Promise<void>;
  queueResultDelivery(parentSessionId: string): Promise<void>;
};

export type PiServiceCronAdapterContext = {
  createCronSession: (
    workspace: WorkspaceInfo,
    options: {
      jobId: string;
      runId: string;
      modelId: string;
      thinkingLevel: string;
      parentSessionId?: string;
      copySessionPath?: string;
    },
  ) => Promise<SessionState>;
  promptCron: (sessionId: string, notice: RuntimeNotice, operationId: string) => Promise<void>;
  resolveOrCreateDailySession: (
    workspace: WorkspaceInfo,
    options?: { modelId?: string; thinkingLevel?: string },
  ) => Promise<SessionState>;
  requireSession: (sessionId: string) => WebSession;
  requireSessionPath: (sessionId: string) => string;
  prepareSessionForContextCopy: <T>(sessionId: string, run: () => Promise<T>) => Promise<T>;
  runSubagentSerial: <T>(sessionId: string, run: () => Promise<T>) => Promise<T>;
  getState: (sessionId: string) => SessionState;
  publishReset: (webSession: WebSession, state: SessionState) => void;
  setThinkingLevel: (sessionId: string, thinkingLevel: string) => Promise<SessionState>;
  setModel: (sessionId: string, modelId: string) => Promise<SessionState>;
  onAgentCompleted?: (session: SessionState) => Promise<void>;
  notifyWorkspaceUpdated: (workspaceId: string) => Promise<void>;
};

/** The scheduler's run ID is the native operation ID, not a second execution journal. */
export async function executeCronOperation(
  session: AgentSession,
  notice: RuntimeNotice,
  operationId: string,
  recover = false,
): Promise<void> {
  let result = await cronOperationResult(session, operationId);
  if (!result) {
    const execution = await session.lane.inspectExecution(nativeContext);
    if (execution.current && execution.current.id !== operationId) {
      throw new Error(`Cron operation ${operationId} does not own this session`);
    }
    if (!execution.current) {
      if (recover) throw new Error("Batty stopped before this cron operation was admitted");
      getOrThrow(
        await session.lane.accept(
          {
            kind: "prompt",
            operationId,
            prompt: cronNoticeMessage(notice, { runId: operationId }, Date.now()),
          },
          nativeContext,
        ),
      );
    }
    await session.resume();
    result = await cronOperationResult(session, operationId);
  }
  if (!result) throw new Error(`Cron operation ${operationId} has no terminal result`);
  if (result.status !== "completed") {
    throw new Error(result.error?.message ?? `Cron run ${result.status}`);
  }
}

export async function recoverCronJobSession(
  context: PiServiceCronAdapterContext & {
    openSession(workspace: WorkspaceInfo, sessionPath: string): Promise<SessionState>;
  },
  job: CronJobRun & { sessionPath: string; startedAtMs: number },
): Promise<{ sessionId: string; sessionPath: string }> {
  const restored = await context.openSession(job.workspace, job.sessionPath);
  const child = context.requireSession(restored.id).session;
  const notice = buildCronRuntimeNotice({
    scheduleLabel: job.scheduleLabel,
    prompt: job.prompt,
    session: job.session,
    now: new Date(job.startedAtMs),
  });
  const binding = cronRunBinding(child, job.runId);
  if (job.session.kind === "daily-inline") {
    return runCronJobSession(context, job, { parent: restored, cronNotice: notice });
  }
  if (
    job.session.kind === "daily-detached" &&
    !binding?.parentSessionId &&
    job.session.includePreviousContext
  ) {
    return runCronJobSession(context, job, { parent: restored, cronNotice: notice });
  }
  if (job.session.kind === "daily-detached" && !binding?.parentSessionId) {
    throw new Error(`Cron run ${job.runId} has no persisted parent binding`);
  }
  const parentSessionId =
    job.session.kind === "daily-detached" ? binding!.parentSessionId : undefined;
  const abort = () => {
    void child.lane
      .requestAbort(job.runId, nativeContext)
      .catch((error) => console.error("Failed to stop recovered cron operation", error));
  };
  job.signal.addEventListener("abort", abort, { once: true });
  if (job.signal.aborted) abort();
  let error: unknown;
  try {
    await executeCronOperation(child, notice, job.runId, true);
  } catch (caught) {
    // An open operation belongs to Pi recovery, even if the process is shutting down.
    if (!(await cronOperationResult(child, job.runId))) throw caught;
    error = caught;
  } finally {
    job.signal.removeEventListener("abort", abort);
  }
  if (
    parentSessionId &&
    (error || extractAssistantText(await lastCronAssistant(child, job.runId)) !== "NO_REPLY")
  ) {
    await job.queueResultDelivery(parentSessionId);
  }
  if (error) throw error;
  return { sessionId: child.sessionId, sessionPath: child.sessionFile };
}

export async function deliverSkippedCronJobRun(
  context: PiServiceCronAdapterContext,
  job: Omit<CronJobRun, "signal" | "onSessionStarted" | "queueResultDelivery">,
  skipped: { skippedAtMs: number; activeRun: RunningCronJob; reason: string },
): Promise<void> {
  if (job.session.kind === "new") {
    return;
  }

  const session = await context.resolveOrCreateDailySession(job.workspace);
  const notice = buildCronRuntimeNotice({
    scheduleLabel: job.scheduleLabel,
    prompt: job.prompt,
    session: job.session,
    phase: "skipped",
    now: new Date(skipped.skippedAtMs),
  });

  await context.runSubagentSerial(session.id, async () => {
    const parent = context.requireSession(session.id);
    const appended = await appendCronErrorDelivery(
      parent.session,
      notice,
      job,
      skipped.reason,
      skipped.skippedAtMs,
    );
    if (!appended) return;
    const state = context.getState(parent.id);
    context.publishReset(parent, state);
    await context.onAgentCompleted?.(state);
    await context.notifyWorkspaceUpdated(parent.workspace.id);
  });
}

export async function runCronJobSession(
  context: PiServiceCronAdapterContext,
  job: CronJobRun,
  recovery?: { parent: SessionState; cronNotice: RuntimeNotice },
): Promise<{ sessionId: string; sessionPath: string }> {
  const cronNotice =
    recovery?.cronNotice ??
    buildCronRuntimeNotice({
      scheduleLabel: job.scheduleLabel,
      prompt: job.prompt,
      session: job.session,
    });

  if (job.session.kind === "daily-inline") {
    return runInlineCronJob(context, job, cronNotice, recovery?.parent);
  }

  const parent =
    recovery?.parent ??
    (job.session.kind === "daily-detached"
      ? await context.resolveOrCreateDailySession(job.workspace)
      : undefined);
  const includePreviousContext =
    job.session.kind === "daily-detached" && job.session.includePreviousContext === true;
  const createCronSession = () =>
    context.createCronSession(job.workspace, {
      jobId: job.jobId,
      runId: job.runId,
      modelId: job.model,
      thinkingLevel: job.thinkingLevel,
      ...(parent ? { parentSessionId: parent.sessionId } : {}),
      ...(parent && includePreviousContext
        ? { copySessionPath: context.requireSessionPath(parent.id) }
        : {}),
    });
  let cronSession: SessionState;
  if (parent && includePreviousContext) {
    await job.onSessionStarted({
      sessionId: parent.sessionId,
      sessionPath: context.requireSessionPath(parent.id),
    });
    cronSession = await context.prepareSessionForContextCopy(parent.id, createCronSession);
  } else {
    cronSession = await createCronSession();
  }
  const cronWebSession = context.requireSession(cronSession.id);
  const cronSessionPath = context.requireSessionPath(cronWebSession.id);
  await job.onSessionStarted({
    sessionId: cronWebSession.session.sessionId,
    sessionPath: cronSessionPath,
  });

  const abortListener = () => {
    void cronWebSession.session.lane
      .requestAbort(job.runId, nativeContext)
      .catch((error) => console.error("Failed to stop cron operation", error));
  };
  if (job.signal.aborted) {
    abortListener();
  } else {
    job.signal.addEventListener("abort", abortListener, { once: true });
  }

  try {
    job.signal.throwIfAborted();
    await context.promptCron(cronWebSession.id, cronNotice, job.runId);
  } catch (error) {
    if (parent) {
      await job.queueResultDelivery(parent.sessionId);
    }
    throw error;
  } finally {
    job.signal.removeEventListener("abort", abortListener);
  }

  const finalAssistant = await lastCronAssistant(cronWebSession.session, job.runId);
  const errorMessage = finalAssistantError(finalAssistant);
  if (
    parent &&
    !(errorMessage === undefined && extractAssistantText(finalAssistant) === "NO_REPLY")
  ) {
    await job.queueResultDelivery(parent.sessionId);
  }
  if (errorMessage) {
    throw new Error(errorMessage);
  }

  return {
    sessionId: cronWebSession.session.sessionId,
    sessionPath: cronSessionPath,
  };
}

async function runInlineCronJob(
  context: PiServiceCronAdapterContext,
  job: CronJobRun,
  cronNotice: RuntimeNotice,
  restored?: SessionState,
): Promise<{ sessionId: string; sessionPath: string }> {
  const session =
    restored ??
    (await context.resolveOrCreateDailySession(job.workspace, {
      modelId: job.model,
      thinkingLevel: job.thinkingLevel,
    }));
  const webSession = context.requireSession(session.id);
  await job.onSessionStarted({
    sessionId: webSession.session.sessionId,
    sessionPath: context.requireSessionPath(webSession.id),
  });

  return context.runSubagentSerial(webSession.session.sessionId, async () => {
    await webSession.session.waitForIdle();
    await context.setModel(session.id, job.model);
    await context.setThinkingLevel(session.id, job.thinkingLevel);
    context.publishReset(webSession, context.getState(webSession.id));

    const abortListener = () => {
      void webSession.session.lane
        .requestAbort(job.runId, nativeContext)
        .catch((error) => console.error("Failed to stop inline cron operation", error));
    };
    if (job.signal.aborted) {
      abortListener();
    } else {
      job.signal.addEventListener("abort", abortListener, { once: true });
    }

    try {
      job.signal.throwIfAborted();
      await context.promptCron(session.id, cronNotice, job.runId);
    } finally {
      job.signal.removeEventListener("abort", abortListener);
    }
    return {
      sessionId: webSession.session.sessionId,
      sessionPath: context.requireSessionPath(webSession.id),
    };
  });
}

export async function deliverCronJobRun(
  context: PiServiceCronAdapterContext & {
    openSessionById(workspace: WorkspaceInfo, sessionId: string): Promise<SessionState>;
    openSessionForDelivery(
      workspace: WorkspaceInfo,
      sessionPath: string,
    ): Promise<{ state: SessionState; owned: boolean }>;
    disposeSession(sessionId: string): void;
  },
  job: CronRunLog & {
    workspace: WorkspaceInfo;
    sessionId: string;
    sessionPath: string;
  },
  delivery: PendingCronRunDelivery,
): Promise<void> {
  const opened = await context.openSessionForDelivery(job.workspace, job.sessionPath);
  let captured: {
    sessionId: string;
    sessionPath: string;
    finalAssistant?: AssistantMessage;
  };
  try {
    const child = context.requireSession(opened.state.id).session;
    const binding = cronRunBinding(child, job.runId);
    if (binding?.parentSessionId !== delivery.parentSessionId) {
      throw new Error(`Cron run ${job.runId} has an invalid persisted parent binding`);
    }
    captured = {
      sessionId: child.sessionId,
      sessionPath: child.sessionFile,
      finalAssistant: await lastCronAssistant(child, job.runId),
    };
  } finally {
    if (opened.owned) context.disposeSession(opened.state.id);
  }

  if (!job.error && extractAssistantText(captured.finalAssistant) === "NO_REPLY") return;
  const parentState = await context.openSessionById(job.workspace, delivery.parentSessionId);
  await context.runSubagentSerial(parentState.id, async () => {
    const parent = context.requireSession(parentState.id);
    await parent.session.waitForIdle();
    const appended = await appendCronRunDelivery(parent.session, job, captured, job.error);
    if (!appended) return;
    const state = context.getState(parent.id);
    context.publishReset(parent, state);
    await context.onAgentCompleted?.(state);
    await context.notifyWorkspaceUpdated(parent.workspace.id);
  });
}

function cronRunBinding(session: AgentSession, runId: string): CronRunSessionBinding | undefined {
  const marker = session.sessionManager
    .getEntries()
    .findLast(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === CRON_RUN_SESSION_CUSTOM_TYPE &&
        (entry.data as unknown as CronRunSessionBinding).runId === runId,
    );
  return marker?.type === "custom" ? (marker.data as unknown as CronRunSessionBinding) : undefined;
}

async function appendCronErrorDelivery(
  parent: AgentSession,
  cronNotice: RuntimeNotice,
  job: Pick<CronJobRun, "jobId" | "runId" | "workspace" | "prompt">,
  errorMessage: string,
  timestamp = Date.now(),
): Promise<boolean> {
  const jobId = job.jobId;
  const runId = job.runId;
  const workspaceId = job.workspace.id;
  return appendResultDelivery(parent, `cron:${runId}`, [
    cronNoticeMessage(
      cronNotice,
      {
        jobId,
        runId,
        workspaceId,
        prompt: job.prompt,
      },
      timestamp,
    ),
    errorAssistant(parent, errorMessage, timestamp + 1),
  ]);
}

async function appendCronRunDelivery(
  parent: AgentSession,
  job: Pick<CronJobRun, "jobId" | "runId" | "workspace" | "prompt" | "scheduleLabel" | "session">,
  delivery: {
    sessionId: string;
    sessionPath: string;
    finalAssistant?: AssistantMessage;
  },
  error?: unknown,
): Promise<boolean> {
  const timestamp = Date.now();
  return appendResultDelivery(parent, `cron:${job.runId}`, [
    cronNoticeMessage(
      buildCronRuntimeNotice({
        scheduleLabel: job.scheduleLabel,
        prompt: job.prompt,
        session: job.session,
        phase: "delivery",
        now: new Date(timestamp),
      }),
      {
        jobId: job.jobId,
        runId: job.runId,
        workspaceId: job.workspace.id,
        sessionId: delivery.sessionId,
        sessionPath: delivery.sessionPath,
        prompt: job.prompt,
      },
      timestamp,
    ),
    deliveredAssistant(parent, delivery.finalAssistant, timestamp + 1, error),
  ]);
}

function cronNoticeMessage(
  cronNotice: RuntimeNotice,
  cron: Record<string, unknown>,
  timestamp: number,
): Message {
  return {
    role: "custom",
    customType: `batty-runtime-notice:${cronNotice.kind}`,
    content: cronNoticeText(cronNotice, cron),
    data: { cron },
    timestamp,
  } as unknown as Message;
}

function cronNoticeText(cronNotice: RuntimeNotice, cron: Record<string, unknown>): string {
  if (typeof cron.sessionPath !== "string") {
    return cronNotice.text;
  }

  return [
    cronNotice.text,
    "",
    "Detached cron session:",
    cron.sessionPath,
    "",
    "The detailed work and tool calls for this cron run are in that detached session. This daily transcript only contains the delivered result.",
  ].join("\n");
}

function errorAssistant(
  parent: AgentSession,
  errorMessage: string,
  timestamp: number,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: errorMessage }],
    api: (parent.model as { api?: string } | undefined)?.api ?? "openai-responses",
    provider: parent.model?.provider ?? "unknown",
    model: parent.model?.id ?? "unknown",
    usage: ZERO_USAGE,
    stopReason: "error",
    errorMessage,
    timestamp,
  };
}

function cronOperationResult(session: AgentSession, operationId: string) {
  // Pi's watch materializes the committed result before completion hooks run.
  // This view survives disposal; only historical operations need a live lane read.
  const result = session.snapshot.lastResult;
  return result?.operationId === operationId
    ? Promise.resolve(result)
    : session.lane.getResult(operationId, nativeContext);
}

async function lastCronAssistant(
  session: AgentSession,
  operationId: string,
): Promise<AssistantMessage | undefined> {
  const result = await cronOperationResult(session, operationId);
  if (!result) return undefined;
  // The presentation index retains immutable entries after the native session closes.
  const entries = new Map(session.sessionManager.getEntries().map((entry) => [entry.id, entry]));
  // Bound delivery to this operation, even if the session was copied from a parent or
  // has since accepted another turn. The base entry itself belongs to earlier context.
  const operationEntries: ReturnType<typeof session.sessionManager.getEntries> = [];
  let id = result.tipId;
  while (id && id !== result.fromTipId) {
    const entry = entries.get(id);
    if (!entry) throw new Error(`Missing cron result entry ${id}`);
    operationEntries.unshift(entry);
    id = entry.parentId;
  }

  const fileChangesByReplyEntryId = agentTurnFileChangesByReplyEntryId(operationEntries);
  const finalEntry = operationEntries.findLast(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  if (!finalEntry || finalEntry.type !== "message") return undefined;
  return {
    ...finalEntry.message,
    battyDeliveredFileChanges: fileChangesByReplyEntryId.get(finalEntry.id) ?? [],
  } as AssistantMessage & { battyDeliveredFileChanges: AgentTurnFileChange[] };
}

function deliveredAssistant(
  parent: AgentSession,
  message: AssistantMessage | undefined,
  timestamp: number,
  error?: unknown,
): AssistantMessage {
  const finalAssistant = stripThinkingFromAssistantMessage(message);
  const deliveredFileChanges = (
    finalAssistant as
      | (AssistantMessage & {
          battyDeliveredFileChanges?: AgentTurnFileChange[];
        })
      | undefined
  )?.battyDeliveredFileChanges;
  if (!error && finalAssistant && assistantHasRenderableContent(finalAssistant)) {
    return {
      ...finalAssistant,
      usage: ZERO_USAGE,
      timestamp,
    };
  }

  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : String(error)
    : finalAssistantError(finalAssistant);
  const text =
    (finalAssistant ? extractAssistantText(finalAssistant) : "") || errorMessage || "(no output)";
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: (parent.model as { api?: string } | undefined)?.api ?? "openai-responses",
    provider: parent.model?.provider ?? "unknown",
    model: parent.model?.id ?? "unknown",
    usage: ZERO_USAGE,
    stopReason: errorMessage ? "error" : "stop",
    errorMessage,
    timestamp,
    ...(deliveredFileChanges === undefined
      ? {}
      : { battyDeliveredFileChanges: deliveredFileChanges }),
  };
}

function finalAssistantError(message: AssistantMessage | undefined): string | undefined {
  if (!message || (message.stopReason !== "error" && message.stopReason !== "aborted")) {
    return undefined;
  }
  return extractAssistantText(message) || message.errorMessage || "Cron run failed";
}

function assistantHasRenderableContent(message: AssistantMessage): boolean {
  if (!Array.isArray(message.content)) {
    return false;
  }

  return message.content.some((block) => {
    if (typeof block !== "object" || block === null) {
      return false;
    }
    if (block.type === "thinking") {
      return false;
    }
    if (block.type === "text") {
      return typeof block.text === "string" && block.text.trim().length > 0;
    }
    return true;
  });
}
