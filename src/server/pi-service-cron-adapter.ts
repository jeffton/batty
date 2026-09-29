import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { CRON_RUN_SESSION_CUSTOM_TYPE, type CronRunSessionBinding } from "./cron-session";
import { appendResultMessages } from "./session-result-delivery";
import type { AgentSessionController as AgentSession } from "./agent-session-controller";
import type {
  CronJobSession,
  CronRunLog,
  PendingCronRunDelivery,
  RunningCronJob,
  SessionState,
  SiteDescriptor,
  SentFileDescriptor,
  WorkspaceInfo,
} from "@/shared/types";
import { buildCronRuntimeNotice, type RuntimeNotice } from "./runtime-notices";
import type { WebSession } from "./pi-service-types";
import {
  collectSentFiles,
  collectSites,
  SUBAGENT_SESSION_CUSTOM_TYPE,
  extractAssistantText,
  stripThinkingFromAssistantMessage,
  ZERO_USAGE,
} from "./subagent";
import { agentTurnArtifactsByReplyEntryId } from "./agent-turn-file-changes";
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
      previousContext?: {
        sourceSessionPath: string;
        mode: true | "chat-only";
      };
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

export const CRON_EXECUTION_CUSTOM_TYPE = "batty-cron-execution";
const activeCronRuns = new WeakMap<AgentSession, string>();
const cronRunSignals = new WeakMap<AgentSession, { runId: string; signal: AbortSignal }>();

export type CronExecutionResult = {
  runId: string;
  startEntryId: string | null;
  endEntryId: string | null;
  status: "running" | "completed" | "failed" | "aborted";
  error?: string;
};

export function getCronExecutionResult(
  session: AgentSession,
  runId: string,
): CronExecutionResult | undefined {
  const entry = session.sessionManager
    .getEntries()
    .findLast(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === CRON_EXECUTION_CUSTOM_TYPE &&
        (entry.data as CronExecutionResult).runId === runId,
    );
  return entry?.type === "custom" ? (entry.data as CronExecutionResult) : undefined;
}

/** Persist scheduler-owned boundaries without resuming an interrupted SDK turn. */
export async function executeCronOperation(
  session: AgentSession,
  notice: RuntimeNotice,
  runId: string,
): Promise<void> {
  const previous = getCronExecutionResult(session, runId);
  if (previous) {
    if (previous.status === "completed") return;
    throw new Error(previous.error ?? `Cron run ${previous.status}`);
  }
  await session.waitForIdle();
  const startEntryId = session.sessionManager.getLeafId();
  const record: CronExecutionResult = { runId, startEntryId, endEntryId: null, status: "running" };
  await session.sessionManager.appendCustomEntry(CRON_EXECUTION_CUSTOM_TYPE, record);
  activeCronRuns.set(session, runId);
  const runSignal = cronRunSignals.get(session);
  const signal = runSignal?.runId === runId ? runSignal.signal : undefined;
  try {
    signal?.throwIfAborted();
    await session.sendCustomMessage(
      {
        customType: `batty-runtime-notice:${notice.kind}`,
        content: notice.text,
        details: { cron: { runId } },
        display: true,
      },
      {
        triggerTurn: true,
        onAccepted: () => {
          if (signal?.aborted) abortOwnedCron(session, runId);
        },
      },
    );
    await session.waitForIdle();
    const assistant = findRunAssistant(session, startEntryId, session.sessionManager.getLeafId());
    const error = finalAssistantError(assistant);
    const status = assistant?.stopReason === "aborted" ? "aborted" : error ? "failed" : "completed";
    await session.sessionManager.appendCustomEntry(CRON_EXECUTION_CUSTOM_TYPE, {
      ...record,
      endEntryId: session.sessionManager.getLeafId(),
      status,
      ...(error ? { error } : {}),
    });
    if (error) throw new Error(error);
  } catch (error) {
    if (getCronExecutionResult(session, runId)?.status === "running") {
      await session.sessionManager.appendCustomEntry(CRON_EXECUTION_CUSTOM_TYPE, {
        ...record,
        endEntryId: session.sessionManager.getLeafId(),
        status: signal?.aborted ? "aborted" : "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    activeCronRuns.delete(session);
  }
}

function abortOwnedCron(session: AgentSession, runId: string): void {
  if (activeCronRuns.get(session) !== runId) return;
  void session.abort().catch((error) => console.error("Failed to stop cron run", error));
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
    await appendCronErrorDelivery(parent.session, notice, job, skipped.reason, skipped.skippedAtMs);
    const state = context.getState(parent.id);
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
    session: job.session,
  });

  if (job.session.kind === "daily-inline") {
    return runInlineCronJob(context, job, cronNotice);
  }

  const parent =
    job.session.kind === "daily-detached"
      ? await context.resolveOrCreateDailySession(job.workspace)
      : undefined;
  const includePreviousContext =
    job.session.kind === "daily-detached" ? (job.session.includePreviousContext ?? false) : false;
  const createCronSession = () =>
    context.createCronSession(job.workspace, {
      jobId: job.jobId,
      runId: job.runId,
      modelId: job.model,
      thinkingLevel: job.thinkingLevel,
      ...(parent ? { parentSessionId: parent.sessionId } : {}),
      ...(parent && includePreviousContext
        ? {
            previousContext: {
              sourceSessionPath: context.requireSessionPath(parent.id),
              mode: includePreviousContext,
            },
          }
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

  cronRunSignals.set(cronWebSession.session, { runId: job.runId, signal: job.signal });
  const abortListener = () => {
    abortOwnedCron(cronWebSession.session, job.runId);
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
    cronRunSignals.delete(cronWebSession.session);
  }

  const finalAssistant = await lastCronAssistant(cronWebSession.session, job.runId);
  const errorMessage = finalAssistantError(finalAssistant);
  const sharedSites = (
    finalAssistant as (AssistantMessage & { battyDeliveredSites?: SiteDescriptor[] }) | undefined
  )?.battyDeliveredSites;
  const sentFiles = sentFilesFromAssistant(finalAssistant);
  if (
    parent &&
    !(
      errorMessage === undefined &&
      extractAssistantText(finalAssistant) === "NO_REPLY" &&
      !sharedSites?.length &&
      !sentFiles.length
    )
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
): Promise<{ sessionId: string; sessionPath: string }> {
  const session = await context.resolveOrCreateDailySession(job.workspace, {
    modelId: job.model,
    thinkingLevel: job.thinkingLevel,
  });
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

    cronRunSignals.set(webSession.session, { runId: job.runId, signal: job.signal });
    const abortListener = () => {
      abortOwnedCron(webSession.session, job.runId);
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
      cronRunSignals.delete(webSession.session);
    }
    return {
      sessionId: webSession.session.sessionId,
      sessionPath: context.requireSessionPath(webSession.id),
    };
  });
}

export async function deliverCronFollowup(
  context: Pick<
    PiServiceCronAdapterContext,
    | "runSubagentSerial"
    | "getState"
    | "publishReset"
    | "onAgentCompleted"
    | "notifyWorkspaceUpdated"
  > & {
    openSessionById(workspace: WorkspaceInfo, sessionId: string): Promise<SessionState>;
    requireSession(sessionId: string): WebSession;
  },
  workspace: WorkspaceInfo,
  cronSession: AgentSession,
): Promise<void> {
  const entries = cronSession.sessionManager.getEntries();
  if (
    entries.some(
      (entry) => entry.type === "custom" && entry.customType === SUBAGENT_SESSION_CUSTOM_TYPE,
    )
  )
    return;
  const binding = entries.find(
    (entry) => entry.type === "custom" && entry.customType === CRON_RUN_SESSION_CUSTOM_TYPE,
  );
  const cronBinding =
    binding?.type === "custom" ? (binding.data as unknown as CronRunSessionBinding) : undefined;
  if (!cronBinding?.parentSessionId) return;

  const branch = cronSession.sessionManager.getBranch();
  const boundary = branch.findLastIndex(
    (entry) => entry.type === "custom" && entry.customType === CRON_EXECUTION_CUSTOM_TYPE,
  );
  if (
    boundary >= 0 &&
    (branch[boundary] as { data: CronExecutionResult }).data.status === "running"
  )
    return;
  const followingEntries = branch.slice(boundary + 1);
  const turnStart = followingEntries.findLastIndex(
    (entry) =>
      entry.type === "custom_message" ||
      (entry.type === "message" && entry.message.role === "user"),
  );
  const turnEntries = followingEntries.slice(Math.max(0, turnStart));
  const reply = turnEntries.findLast(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  if (!reply || reply.type !== "message") return;
  const turnMessages = turnEntries.flatMap((entry) =>
    entry.type === "message" ? [entry.message] : [],
  );
  const artifacts = agentTurnArtifactsByReplyEntryId(turnEntries).get(reply.id);
  const assistant = {
    ...reply.message,
    battyDeliveredFileChanges: artifacts?.fileChanges ?? [],
    battyDeliveredSites: [...(artifacts?.sites ?? []), ...collectSites(turnMessages)].filter(
      (site, index, sites) => sites.findIndex((candidate) => candidate.id === site.id) === index,
    ),
  } as AssistantMessage & {
    battyDeliveredFileChanges: AgentTurnFileChange[];
    battyDeliveredSites: SiteDescriptor[];
  };
  const sentFiles = [...(artifacts?.sentFiles ?? []), ...collectSentFiles(turnMessages)].filter(
    (file, index, files) => files.findIndex((candidate) => candidate.id === file.id) === index,
  );
  if (
    extractAssistantText(assistant) === "NO_REPLY" &&
    !assistant.battyDeliveredSites.length &&
    !sentFiles.length
  )
    return;

  const parentState = await context.openSessionById(workspace, cronBinding.parentSessionId);
  await context.runSubagentSerial(parentState.id, async () => {
    const parent = context.requireSession(parentState.id);
    const timestamp = Date.now();
    await appendResultMessages(parent.session, [
      {
        role: "custom",
        customType: "batty-runtime-notice:cron",
        content: `Follow-up from detached cron session:\n${cronSession.sessionFile}`,
        details: { cron: { sessionPath: cronSession.sessionFile } },
        timestamp,
      } as unknown as Message,
      ...deliveredSitesMessage(assistant, reply.id, timestamp + 1),
      ...deliveredFilesMessage(sentFiles, reply.id, timestamp + 2),
      deliveredAssistant(parent.session, assistant, timestamp + 3),
    ]);
    const state = context.getState(parent.id);
    context.publishReset(parent, state);
    await context.onAgentCompleted?.(state);
    await context.notifyWorkspaceUpdated(parent.workspace.id);
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

  const sharedSites = (
    captured.finalAssistant as
      | (AssistantMessage & { battyDeliveredSites?: SiteDescriptor[] })
      | undefined
  )?.battyDeliveredSites;
  const sentFiles = sentFilesFromAssistant(captured.finalAssistant);
  if (
    !job.error &&
    extractAssistantText(captured.finalAssistant) === "NO_REPLY" &&
    !sharedSites?.length &&
    !sentFiles.length
  ) {
    return;
  }
  const parentState = await context.openSessionById(job.workspace, delivery.parentSessionId);
  await context.runSubagentSerial(parentState.id, async () => {
    const parent = context.requireSession(parentState.id);
    await parent.session.waitForIdle();
    await appendCronRunDelivery(parent.session, job, captured, job.error);
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
): Promise<void> {
  const jobId = job.jobId;
  const runId = job.runId;
  const workspaceId = job.workspace.id;
  await appendResultMessages(parent, [
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
): Promise<void> {
  const timestamp = Date.now();
  await appendResultMessages(parent, [
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
    ...deliveredSitesMessage(delivery.finalAssistant, job.runId, timestamp + 1),
    ...deliveredFilesMessage(
      sentFilesFromAssistant(delivery.finalAssistant),
      job.runId,
      timestamp + 2,
    ),
    deliveredAssistant(parent, delivery.finalAssistant, timestamp + 3, error),
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
    details: { cron },
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

function cronRunEntries(
  session: AgentSession,
  startEntryId: string | null,
  endEntryId: string | null,
) {
  const entries = new Map(session.sessionManager.getEntries().map((entry) => [entry.id, entry]));
  const operationEntries: ReturnType<typeof session.sessionManager.getEntries> = [];
  let id = endEntryId;
  while (id && id !== startEntryId) {
    const entry = entries.get(id);
    if (!entry) throw new Error(`Missing cron result entry ${id}`);
    operationEntries.unshift(entry);
    id = entry.parentId;
  }
  return operationEntries;
}

function findRunAssistant(
  session: AgentSession,
  startEntryId: string | null,
  endEntryId: string | null,
) {
  const entry = cronRunEntries(session, startEntryId, endEntryId).findLast(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  return entry?.type === "message" ? (entry.message as AssistantMessage) : undefined;
}

async function lastCronAssistant(
  session: AgentSession,
  runId: string,
): Promise<AssistantMessage | undefined> {
  const result = getCronExecutionResult(session, runId);
  if (!result || result.status === "running") return undefined;
  const operationEntries = cronRunEntries(session, result.startEntryId, result.endEntryId);

  const artifactsByReplyEntryId = agentTurnArtifactsByReplyEntryId(operationEntries);
  const finalEntry = operationEntries.findLast(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  if (!finalEntry || finalEntry.type !== "message") return undefined;
  const operationMessages = operationEntries.flatMap((entry) =>
    entry.type === "message" ? [entry.message] : [],
  );
  const artifacts = artifactsByReplyEntryId.get(finalEntry.id);
  return {
    ...finalEntry.message,
    battyDeliveredFileChanges: artifacts?.fileChanges ?? [],
    battyDeliveredSites: [...(artifacts?.sites ?? []), ...collectSites(operationMessages)].filter(
      (site, index, sites) => sites.findIndex((candidate) => candidate.id === site.id) === index,
    ),
    battyDeliveredSentFiles: [
      ...(artifacts?.sentFiles ?? []),
      ...collectSentFiles(operationMessages),
    ].filter(
      (file, index, files) => files.findIndex((candidate) => candidate.id === file.id) === index,
    ),
  } as AssistantMessage & {
    battyDeliveredFileChanges: AgentTurnFileChange[];
    battyDeliveredSites: SiteDescriptor[];
    battyDeliveredSentFiles: SentFileDescriptor[];
  };
}

function sentFilesFromAssistant(message: AssistantMessage | undefined): SentFileDescriptor[] {
  return (
    (message as (AssistantMessage & { battyDeliveredSentFiles?: SentFileDescriptor[] }) | undefined)
      ?.battyDeliveredSentFiles ?? []
  );
}

function deliveredFilesMessage(
  files: SentFileDescriptor[],
  replyId: string,
  timestamp: number,
): Message[] {
  if (!files.length) return [];
  return [
    {
      role: "toolResult",
      toolCallId: `cron-files:${replyId}`,
      toolName: "attach-files",
      content: [
        { type: "text", text: `Attached ${files.length} file${files.length === 1 ? "" : "s"}.` },
      ],
      details: { sentFiles: files },
      isError: false,
      timestamp,
    } as unknown as Message,
  ];
}

function deliveredSitesMessage(
  message: AssistantMessage | undefined,
  runId: string,
  timestamp: number,
): Message[] {
  const sites = (
    message as (AssistantMessage & { battyDeliveredSites?: SiteDescriptor[] }) | undefined
  )?.battyDeliveredSites;
  if (!sites?.length) return [];
  return [
    {
      role: "toolResult",
      toolCallId: `cron-sites:${runId}`,
      toolName: "sites",
      content: [
        { type: "text", text: `Shared ${sites.length} site${sites.length === 1 ? "" : "s"}.` },
      ],
      details: { sites },
      isError: false,
      timestamp,
    } as unknown as Message,
  ];
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
