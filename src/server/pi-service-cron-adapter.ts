import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CronJobSession, RunningCronJob, SessionState, WorkspaceInfo } from "@/shared/types";
import { buildCronRuntimeNotice, type RuntimeNotice } from "./runtime-notices";
import { appendMessages } from "./pi-service-subagents";
import type { WebSession } from "./pi-service-types";
import {
  extractAssistantText,
  findLastAssistantMessage,
  stripThinkingFromAssistantMessage,
  ZERO_USAGE,
} from "./subagent";

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
  promptCron: (sessionId: string, notice: RuntimeNotice) => Promise<void>;
  resolveOrCreateDailySession: (
    workspace: WorkspaceInfo,
    options?: { modelId?: string; thinkingLevel?: string },
  ) => Promise<SessionState>;
  requireSession: (sessionId: string) => WebSession;
  requireSessionPath: (sessionId: string) => string;
  prepareSessionForContextCopy: (sessionId: string) => Promise<void>;
  runSubagentSerial: <T>(sessionId: string, run: () => Promise<T>) => Promise<T>;
  getState: (sessionId: string) => SessionState;
  publishReset: (webSession: WebSession, state: SessionState) => void;
  setThinkingLevel: (sessionId: string, thinkingLevel: string) => SessionState;
  setModel: (sessionId: string, modelId: string) => Promise<SessionState>;
  onAgentCompleted?: (session: SessionState) => Promise<void>;
  notifyWorkspaceUpdated: (workspaceId: string) => Promise<void>;
};

export async function deliverSkippedCronJobRun(
  context: PiServiceCronAdapterContext,
  job: Omit<CronJobRun, "signal" | "onSessionStarted">,
  skipped: { skippedAtMs: number; activeRun: RunningCronJob; reason: string },
): Promise<void> {
  if (job.session.kind === "new") {
    return;
  }

  const session = await context.resolveOrCreateDailySession(job.workspace);
  const notice = buildCronRuntimeNotice({
    scheduleLabel: job.scheduleLabel,
    prompt: job.prompt,
    now: new Date(skipped.skippedAtMs),
  });

  await context.runSubagentSerial(session.id, async () => {
    const parent = context.requireSession(session.id);
    appendCronErrorDelivery(parent.session, notice, job, skipped.reason, skipped.skippedAtMs);
    const state = {
      ...context.getState(parent.id),
      isStreaming: false,
      pendingMessageCount: 0,
      activeAssistant: undefined,
    };
    context.publishReset(parent, state);
    await context.onAgentCompleted?.(state);
    await context.notifyWorkspaceUpdated(parent.workspace.id);
  });
}

export async function runCronJobSession(
  context: PiServiceCronAdapterContext,
  job: CronJobRun,
): Promise<{ sessionId: string; sessionPath: string }> {
  const cronNotice = buildCronRuntimeNotice({
    scheduleLabel: job.scheduleLabel,
    prompt: job.prompt,
  });

  if (job.session.kind === "daily-inline") {
    return runInlineCronJob(context, job, cronNotice);
  }

  const parent =
    job.session.kind === "daily-detached"
      ? await context.resolveOrCreateDailySession(job.workspace)
      : undefined;
  const includePreviousContext =
    job.session.kind === "daily-detached" && job.session.includePreviousContext === true;
  if (parent && includePreviousContext) {
    await context.prepareSessionForContextCopy(parent.id);
  }
  const parentSessionPath =
    parent && includePreviousContext ? context.requireSessionPath(parent.id) : undefined;
  const cronSession = await context.createCronSession(job.workspace, {
    jobId: job.jobId,
    runId: job.runId,
    modelId: job.model,
    thinkingLevel: job.thinkingLevel,
    ...(parent ? { parentSessionId: parent.sessionId } : {}),
    ...(parentSessionPath ? { copySessionPath: parentSessionPath } : {}),
  });
  const cronWebSession = context.requireSession(cronSession.id);
  const cronSessionPath = context.requireSessionPath(cronWebSession.id);
  await job.onSessionStarted({
    sessionId: cronWebSession.session.sessionId,
    sessionPath: cronSessionPath,
  });

  const abortListener = () => {
    void cronWebSession.session.abort();
  };
  if (job.signal.aborted) {
    abortListener();
  } else {
    job.signal.addEventListener("abort", abortListener, { once: true });
  }

  try {
    await context.promptCron(cronWebSession.id, cronNotice);
  } catch (error) {
    if (parent) {
      await deliverCronRun(context, parent.id, cronNotice, job, cronWebSession.session, error);
    }
    throw error;
  } finally {
    job.signal.removeEventListener("abort", abortListener);
  }

  const finalAssistant = findLastAssistantMessage(cronWebSession.session.messages);
  const errorMessage = finalAssistantError(finalAssistant);
  if (
    parent &&
    !(errorMessage === undefined && extractAssistantText(finalAssistant) === "NO_REPLY")
  ) {
    await deliverCronRun(context, parent.id, cronNotice, job, cronWebSession.session);
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
): Promise<{ sessionId: string; sessionPath: string }> {
  const session = await context.resolveOrCreateDailySession(job.workspace, {
    modelId: job.model,
    thinkingLevel: job.thinkingLevel,
  });
  const webSession = context.requireSession(session.id);

  return context.runSubagentSerial(webSession.session.sessionId, async () => {
    await webSession.session.agent.waitForIdle();
    context.setThinkingLevel(session.id, job.thinkingLevel);
    await context.setModel(session.id, job.model);
    context.publishReset(webSession, context.getState(webSession.id));
    await job.onSessionStarted({
      sessionId: webSession.session.sessionId,
      sessionPath: context.requireSessionPath(webSession.id),
    });

    const abortListener = () => {
      void webSession.session.abort();
    };
    if (job.signal.aborted) {
      abortListener();
    } else {
      job.signal.addEventListener("abort", abortListener, { once: true });
    }

    try {
      await context.promptCron(session.id, cronNotice);
    } finally {
      job.signal.removeEventListener("abort", abortListener);
    }
    return {
      sessionId: webSession.session.sessionId,
      sessionPath: context.requireSessionPath(webSession.id),
    };
  });
}

async function deliverCronRun(
  context: PiServiceCronAdapterContext,
  parentSessionId: string,
  cronNotice: RuntimeNotice,
  job: CronJobRun,
  cronSession: AgentSession,
  error?: unknown,
): Promise<void> {
  await context.runSubagentSerial(parentSessionId, async () => {
    const parent = context.requireSession(parentSessionId);
    await parent.session.agent.waitForIdle();
    appendCronRunDelivery(parent.session, cronNotice, job, cronSession, error);
    const state = {
      ...context.getState(parent.id),
      isStreaming: false,
      pendingMessageCount: 0,
      activeAssistant: undefined,
    };
    context.publishReset(parent, state);
    await context.onAgentCompleted?.(state);
    await context.notifyWorkspaceUpdated(parent.workspace.id);
  });
}

function appendCronErrorDelivery(
  parent: AgentSession,
  cronNotice: RuntimeNotice,
  job: Pick<CronJobRun, "jobId" | "runId" | "workspace" | "prompt">,
  errorMessage: string,
  timestamp = Date.now(),
): void {
  const jobId = job.jobId;
  const runId = job.runId;
  const workspaceId = job.workspace.id;
  appendMessages(parent, [
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

function appendCronRunDelivery(
  parent: AgentSession,
  cronNotice: RuntimeNotice,
  job: CronJobRun,
  cronSession: AgentSession,
  error?: unknown,
): void {
  const timestamp = Date.now();
  appendMessages(parent, [
    cronNoticeMessage(
      cronNotice,
      {
        jobId: job.jobId,
        runId: job.runId,
        workspaceId: job.workspace.id,
        sessionId: cronSession.sessionId,
        sessionPath: cronSession.sessionFile,
        prompt: job.prompt,
      },
      timestamp,
    ),
    deliveredAssistant(parent, cronSession, timestamp + 1, error),
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

function deliveredAssistant(
  parent: AgentSession,
  cronSession: AgentSession,
  timestamp: number,
  error?: unknown,
): AssistantMessage {
  const finalAssistant = stripThinkingFromAssistantMessage(
    findLastAssistantMessage(cronSession.messages),
  );
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
