import { type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DurableFileChange } from "./agent-turn-file-changes";
import {
  appendResultMessages,
  hasDeliveredResult,
  migratedOperationResult,
} from "./session-result-delivery";
import { SessionStore as SessionManager } from "./session-store";
import { createSessionManagerWithPreviousContext } from "./previous-context";
import type { AgentSessionController as AgentSession } from "./agent-session-controller";
import type {
  PreviousContextMode,
  SentFileDescriptor,
  SessionState,
  SessionSummary,
  SiteDescriptor,
  ToolExecutionDetails,
  WorkspaceInfo,
} from "@/shared/types";
import { findBattySystemPromptSnapshot } from "./batty-system-prompt";
import {
  buildDailyCronSessionBinding,
  CRON_SESSION_CUSTOM_TYPE,
  findDailyCronSessionBinding,
  localDayStartMs,
  toLocalIsoDate,
} from "./cron-session";
import {
  buildRuntimeNoticeMessage,
  buildSubagentRuntimeNotice,
  type RuntimeNotice,
} from "./runtime-notices";
import {
  buildSubagentDetails,
  extractAssistantText,
  findLastAssistantMessage,
  hasSubagentSessionMarker,
  newlyGeneratedSubagentMessages,
  SUBAGENT_SESSION_CUSTOM_TYPE,
  stripThinkingFromAssistantMessage,
  ZERO_USAGE,
  type SubagentToolDetails,
} from "./subagent";
import type { PiModel, WebSession } from "./pi-service-types";
import { modelKey } from "./pi-service-types";

export function waitForSubagentQueue(
  subagentQueues: Map<string, Promise<void>>,
  sessionId: string,
) {
  return (subagentQueues.get(sessionId) ?? Promise.resolve()).catch(() => undefined);
}

export async function appendRuntimeNoticeMessage(
  session: AgentSession,
  notice: RuntimeNotice,
  timestamp = Date.now(),
): Promise<void> {
  await appendMessages(session, [buildRuntimeNoticeMessage(notice, timestamp) as Message]);
}

export async function runSubagentSerial<T>(
  subagentQueues: Map<string, Promise<void>>,
  sessionId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = subagentQueues.get(sessionId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  subagentQueues.set(sessionId, queued);

  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release?.();
    if (subagentQueues.get(sessionId) === queued) {
      subagentQueues.delete(sessionId);
    }
  }
}

export function resolveSubagentDefaults(
  liveSession: AgentSession | undefined,
  ctx: ExtensionContext,
): {
  modelId?: string;
  thinkingLevel: string;
} {
  const snapshot = findBattySystemPromptSnapshot(ctx.sessionManager.getEntries());

  return {
    modelId:
      liveSession?.model != null
        ? modelKey(liveSession.model as PiModel)
        : ctx.model != null
          ? modelKey(ctx.model as PiModel)
          : snapshot?.model,
    thinkingLevel: liveSession?.thinkingLevel ?? snapshot?.thinkingLevel ?? "medium",
  };
}

export interface DetachedSubagentOptions {
  sessionId?: string;
  workspace: WorkspaceInfo;
  parentSessionId: string;
  parentSessionPath?: string;
  parentSubagentDepth: number;
  contextBranchLeafId?: string | null;
  prompt: string;
  modelId: string;
  thinkingLevel: string;
  includePreviousContext: PreviousContextMode;
  respondIn: "tool-call" | "session";
  deliveryMode?: "append" | "prompt";
  preludeNotices?: RuntimeNotice[];
  currentToolCallId?: string;
  continueSession?: boolean;
  signal?: AbortSignal;
  onReady?: (details: ToolExecutionDetails) => void;
  onDelivered?: () => void;
  onUpdate?: (partial: {
    content: Array<{ type: "text"; text: string }>;
    details: ToolExecutionDetails;
  }) => void;
}

export const SUBAGENT_COMPLETION_CUSTOM_TYPE = "batty-subagent-completion";

export interface DetachedSubagentResult {
  deliveryEntryId: string;
  text: string;
  details: ToolExecutionDetails;
  messages: AgentSession["messages"];
  generatedMessages: AgentSession["messages"];
  finalAssistant?: AssistantMessage;
  isError: boolean;
  errorMessage?: string;
}

export interface RunDetachedSubagentDeps {
  createPiAgentSession: (
    workspace: WorkspaceInfo,
    sessionManager: SessionManager,
    options?: { modelId?: string; thinkingLevel?: string },
  ) => Promise<Awaited<{ session: AgentSession }>>;
  attachSession: (
    workspace: WorkspaceInfo,
    session: AgentSession,
    modelFallbackMessage?: string,
    ephemeral?: boolean,
  ) => WebSession;
  disposeWebSession: (webSession: WebSession) => void;
  workspaceSessionDir: string;
  deliverResultToParent?: (
    options: DetachedSubagentOptions,
    result: DetachedSubagentResult,
  ) => Promise<void>;
}

function buildDetachedSubagentResult(
  subagentSession: AgentSession,
  options: DetachedSubagentOptions,
  seedMessageCount: number,
  errorOverride?: string,
  finalAssistantOverride?: AssistantMessage,
  generatedMessagesOverride?: AgentSession["messages"],
): Omit<DetachedSubagentResult, "deliveryEntryId"> {
  const messages = structuredClone(subagentSession.messages) as AgentSession["messages"];
  const generatedMessages = (
    generatedMessagesOverride ?? newlyGeneratedSubagentMessages(messages, seedMessageCount)
  ).filter((message) => message.role !== "system");
  const finalAssistant = finalAssistantOverride ?? findLastAssistantMessage(generatedMessages);
  const assistantError =
    finalAssistant?.stopReason === "aborted"
      ? finalAssistant.errorMessage || "Subagent stopped by user"
      : finalAssistant?.stopReason === "error"
        ? finalAssistant.errorMessage || "Subagent failed"
        : undefined;
  const errorMessage = errorOverride || assistantError;
  const text = errorMessage || extractAssistantText(finalAssistant) || "";
  const details = buildSubagentDetails(
    {
      prompt: options.prompt,
      model: options.modelId,
      effort: options.thinkingLevel,
      includePreviousContext: options.includePreviousContext,
      respondIn: options.respondIn,
      async: options.deliveryMode === "prompt",
    },
    messages,
    finalAssistant,
    {
      generatedMessages,
      workspaceId: options.workspace.id,
      sessionId: subagentSession.sessionId,
      sessionPath: subagentSession.sessionFile,
    },
  );
  return {
    text,
    details,
    messages,
    generatedMessages,
    finalAssistant,
    isError: errorMessage !== undefined,
    errorMessage,
  };
}

function subagentOperationEntries(
  branch: ReturnType<SessionManager["getBranch"]>,
  startedTurn: boolean,
  startingBranchLength: number,
) {
  if (startedTurn) return branch.slice(startingBranchLength);
  const isCompletion = (entry: (typeof branch)[number]) =>
    (entry.type === "custom" && entry.customType === SUBAGENT_COMPLETION_CUSTOM_TYPE) ||
    migratedOperationResult(entry)?.kind === "run";
  const completionIndex = branch.findLastIndex(isCompletion);
  const completion = branch[completionIndex];
  const migrated = completion ? migratedOperationResult(completion) : undefined;
  if (migrated) {
    const startIndex = branch.findIndex((entry) => entry.id === migrated.fromTipId);
    const endIndex = branch.findIndex((entry) => entry.id === migrated.tipId);
    return branch.slice(startIndex + 1, endIndex + 1);
  }
  const marker = branch.findLastIndex(
    (entry) => entry.type === "custom" && entry.customType === SUBAGENT_SESSION_CUSTOM_TYPE,
  );
  const previousCompletion = branch.slice(0, completionIndex).findLastIndex(isCompletion);
  return branch.slice(
    Math.max(marker, previousCompletion) + 1,
    completion ? completionIndex + 1 : undefined,
  );
}

function isToolCallBlockForId(block: unknown, toolCallId: string): boolean {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "toolCall" &&
    (block as { id?: unknown }).id === toolCallId
  );
}

function resolveDetachedContextLeafId(
  sessionManager: SessionManager,
  options: Pick<DetachedSubagentOptions, "contextBranchLeafId" | "currentToolCallId">,
): string | undefined {
  if (options.contextBranchLeafId !== undefined) {
    return options.contextBranchLeafId ?? undefined;
  }

  if (options.currentToolCallId) {
    const invocation = sessionManager
      .getBranch()
      .findLast(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.content.some((block) =>
            isToolCallBlockForId(block, options.currentToolCallId!),
          ),
      );
    if (!invocation) throw new Error(`Parent tool call not found: ${options.currentToolCallId}`);
    return invocation.parentId ?? undefined;
  }

  return sessionManager.getLeafId() ?? undefined;
}

async function createDetachedSubagentSessionManager(
  deps: RunDetachedSubagentDeps,
  options: DetachedSubagentOptions,
): Promise<{ manager: SessionManager; chatOnlyMessages?: Message[] }> {
  if (options.sessionId) {
    const existing = await SessionManager.existing(
      options.workspace.path,
      deps.workspaceSessionDir,
      options.sessionId,
    );
    if (existing) return { manager: existing };
  }
  const sourceManager =
    options.includePreviousContext && options.parentSessionPath
      ? await SessionManager.open(options.parentSessionPath)
      : undefined;
  const leafId = sourceManager ? resolveDetachedContextLeafId(sourceManager, options) : undefined;
  return createSessionManagerWithPreviousContext({
    cwd: options.workspace.path,
    targetRoot: deps.workspaceSessionDir,
    parentSessionId: options.parentSessionId,
    sessionId: options.sessionId,
    sourceSessionPath: options.parentSessionPath,
    leafId,
    mode: options.includePreviousContext,
  });
}

function subagentUpdateContent(
  options: Pick<DetachedSubagentOptions, "respondIn">,
  text: string,
): Array<{ type: "text"; text: string }> {
  return options.respondIn === "tool-call" && text.trim().length > 0
    ? [{ type: "text", text }]
    : [];
}

export async function runDetachedSubagentSession(
  deps: RunDetachedSubagentDeps,
  options: DetachedSubagentOptions,
): Promise<DetachedSubagentResult> {
  const { manager, chatOnlyMessages } = await createDetachedSubagentSessionManager(deps, options);
  const existing = manager
    .getEntries()
    .some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === SUBAGENT_SESSION_CUSTOM_TYPE &&
        (entry.data as { parentSessionId?: string })?.parentSessionId === options.parentSessionId,
    );
  const result = await deps.createPiAgentSession(
    options.workspace,
    manager,
    existing
      ? undefined
      : {
          modelId: options.modelId,
          thinkingLevel: options.thinkingLevel,
        },
  );
  const subagentSession = result.session;
  if (!existing && chatOnlyMessages) {
    await appendMessages(subagentSession, chatOnlyMessages);
  }
  if (!existing)
    await subagentSession.sessionManager.appendCustomEntry(SUBAGENT_SESSION_CUSTOM_TYPE, {
      sessionId: subagentSession.sessionId,
      parentSessionId: options.parentSessionId,
      depth: options.parentSubagentDepth + 1,
      respondIn: options.respondIn,
      deliveryMode: options.deliveryMode,
    });
  const webSubagentSession = deps.attachSession(
    options.workspace,
    subagentSession,
    undefined,
    true,
  );

  const subagentNotice = buildSubagentRuntimeNotice(
    options.parentSubagentDepth + 1,
    options.prompt,
    options.includePreviousContext,
  );
  const preludeNotices = options.preludeNotices ?? [];
  const initialTimestamp = Date.now();
  const preludeMessages = preludeNotices.map((notice, index) =>
    buildRuntimeNoticeMessage(notice, initialTimestamp + index),
  );
  if (!existing && preludeMessages.length > 0) {
    await appendMessages(subagentSession, preludeMessages as Message[]);
  }
  const seedMessageCount = subagentSession.messages.length;
  const startingBranchLength = subagentSession.sessionManager.getBranch().length;

  const readyDetails = buildSubagentDetails(
    {
      prompt: options.prompt,
      model: options.modelId,
      effort: options.thinkingLevel,
      includePreviousContext: options.includePreviousContext,
      respondIn: options.respondIn,
      async: options.deliveryMode === "prompt",
    },
    subagentSession.messages,
    undefined,
    {
      generatedMessages: newlyGeneratedSubagentMessages(subagentSession.messages, seedMessageCount),
      workspaceId: options.workspace.id,
      sessionId: subagentSession.sessionId,
      sessionPath: subagentSession.sessionFile,
    },
  );
  options.onUpdate?.({ content: [], details: readyDetails });

  let lastText = "";
  let observedFinalAssistant: AssistantMessage | undefined;
  const observedGeneratedMessages: AgentSession["messages"] = [];

  const unsubscribe = subagentSession.subscribe((event) => {
    if (
      event.type !== "message_start" &&
      event.type !== "message_update" &&
      event.type !== "message_end"
    ) {
      return;
    }
    if (event.type === "message_end") {
      observedGeneratedMessages.push(structuredClone(event.message));
    }
    if (event.message.role !== "assistant") {
      return;
    }

    const finalAssistant = event.message as AssistantMessage;
    if (event.type === "message_end") {
      observedFinalAssistant = structuredClone(finalAssistant);
    }

    const text = extractAssistantText(finalAssistant);
    if (!text || text === lastText) {
      return;
    }

    lastText = text;
    options.onUpdate?.({
      content: subagentUpdateContent(options, text),
      details: buildSubagentDetails(
        {
          prompt: options.prompt,
          model: options.modelId,
          effort: options.thinkingLevel,
          includePreviousContext: options.includePreviousContext,
          respondIn: options.respondIn,
          async: options.deliveryMode === "prompt",
        },
        subagentSession.messages,
        finalAssistant,
        {
          generatedMessages: observedGeneratedMessages,
          workspaceId: options.workspace.id,
          sessionId: subagentSession.sessionId,
          sessionPath: subagentSession.sessionFile,
        },
      ),
    });
  });

  const abortListener = () => {
    void subagentSession.abort().catch((error) => console.error("Failed to stop subagent", error));
  };
  if (options.signal) {
    if (options.signal.aborted) {
      abortListener();
    } else {
      options.signal.addEventListener("abort", abortListener, { once: true });
    }
  }

  let deliveringResult = false;
  let startedTurn = false;
  try {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Subagent aborted");
    }
    if (options.continueSession) {
      if (!existing) throw new Error("Subagent session not found");
      startedTurn = true;
      await subagentSession.sendCustomMessage(
        {
          customType: `batty-runtime-notice:${subagentNotice.kind}`,
          content: subagentNotice.text,
          display: true,
        },
        { triggerTurn: true, onAccepted: () => options.onReady?.(readyDetails) },
      );
    } else if (subagentSession.isStreaming) {
      // Another live caller owns this operation; wait for its normal driver to finish.
      options.onReady?.(readyDetails);
      await subagentSession.waitForIdle();
    } else if (!existing) {
      startedTurn = true;
      await subagentSession.sendCustomMessage(
        {
          customType: `batty-runtime-notice:${subagentNotice.kind}`,
          content: subagentNotice.text,
          display: true,
        },
        { triggerTurn: true, onAccepted: () => options.onReady?.(readyDetails) },
      );
    } else {
      const branch = subagentSession.sessionManager.getBranch();
      const marker = branch.findLastIndex(
        (entry) => entry.type === "custom" && entry.customType === SUBAGENT_SESSION_CUSTOM_TYPE,
      );
      if (
        !branch
          .slice(marker + 1)
          .some(
            (entry) =>
              (entry.type === "custom" && entry.customType === SUBAGENT_COMPLETION_CUSTOM_TYPE) ||
              migratedOperationResult(entry)?.kind === "run",
          )
      )
        throw new Error("Detached subagent operation was interrupted");
      options.onReady?.(readyDetails);
    }
    const branch = subagentSession.sessionManager.getBranch();
    const operationEntries = subagentOperationEntries(branch, startedTurn, startingBranchLength);
    const generated = operationEntries.flatMap((entry): AgentSession["messages"] => {
      if (entry.type === "message") {
        return [entry.message];
      }
      if (entry.type === "custom_message") {
        return [
          {
            role: "custom",
            customType: entry.customType,
            content: entry.content,
            details: entry.details,
            display: entry.display,
            timestamp: new Date(entry.timestamp).getTime(),
          },
        ];
      }
      return [];
    });
    const completion = branch.findLast(
      (entry) =>
        (entry.type === "custom" && entry.customType === SUBAGENT_COMPLETION_CUSTOM_TYPE) ||
        migratedOperationResult(entry)?.kind === "run",
    );
    const migratedCompletion = completion ? migratedOperationResult(completion) : undefined;
    const completionError =
      !startedTurn && completion?.type === "custom"
        ? migratedCompletion
          ? (migratedCompletion.error?.message ??
            (migratedCompletion.status === "completed"
              ? undefined
              : `Subagent ${migratedCompletion.status}`))
          : (completion.data as { error?: string }).error
        : undefined;
    const built = buildDetachedSubagentResult(
      subagentSession,
      options,
      seedMessageCount,
      completionError,
      observedFinalAssistant,
      generated,
    );
    const completionEntryId =
      startedTurn || !completion
        ? await subagentSession.sessionManager.appendCustomEntry(SUBAGENT_COMPLETION_CUSTOM_TYPE, {
            status: built.isError ? "failed" : "completed",
            ...(built.errorMessage ? { error: built.errorMessage } : {}),
          })
        : completion.id;
    const assistantEntry = operationEntries.findLast(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    const result: DetachedSubagentResult = {
      ...built,
      deliveryEntryId: assistantEntry?.id ?? completionEntryId,
    };
    if (options.respondIn === "session") {
      deliveringResult = true;
      if (!deps.deliverResultToParent)
        throw new Error("Subagent parent delivery is not configured");
      await deps.deliverResultToParent(options, result);
    }
    return {
      ...result,
      text: result.text || lastText,
    };
  } catch (error) {
    // Delivery failures remain retryable; they must not replace the child's native result.
    if (deliveringResult || subagentSession.isStreaming) throw error;
    const built = buildDetachedSubagentResult(
      subagentSession,
      options,
      seedMessageCount,
      error instanceof Error ? error.message : String(error),
      observedFinalAssistant,
      observedGeneratedMessages.length > 0 ? observedGeneratedMessages : undefined,
    );
    const branch = subagentSession.sessionManager.getBranch();
    const operationEntries = subagentOperationEntries(branch, startedTurn, startingBranchLength);
    const assistantEntry = operationEntries.findLast(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    const previousCompletion = operationEntries.findLast(
      (entry) =>
        (entry.type === "custom" && entry.customType === SUBAGENT_COMPLETION_CUSTOM_TYPE) ||
        migratedOperationResult(entry)?.kind === "run",
    );
    const completionEntryId =
      !startedTurn && previousCompletion
        ? previousCompletion.id
        : await subagentSession.sessionManager.appendCustomEntry(SUBAGENT_COMPLETION_CUSTOM_TYPE, {
            status: "failed",
            error: built.errorMessage,
          });
    const result: DetachedSubagentResult = {
      ...built,
      deliveryEntryId: assistantEntry?.id ?? completionEntryId,
    };
    if (
      options.respondIn === "session" &&
      (observedFinalAssistant || options.deliveryMode === "prompt")
    ) {
      if (!deps.deliverResultToParent)
        throw new Error("Subagent parent delivery is not configured");
      await deps.deliverResultToParent(options, result);
    }
    return {
      ...result,
      text: result.text || lastText || (error instanceof Error ? error.message : String(error)),
      isError: true,
      errorMessage: result.errorMessage || (error instanceof Error ? error.message : String(error)),
    };
  } finally {
    if (options.signal) {
      options.signal.removeEventListener("abort", abortListener);
    }
    unsubscribe();
    if (webSubagentSession.subscribers.size === 0 && !webSubagentSession.session.isStreaming) {
      deps.disposeWebSession(webSubagentSession);
    }
  }
}

export async function deliverDetachedSubagentResult(
  parent: AgentSession,
  result: DetachedSubagentResult,
): Promise<boolean> {
  if (!result.isError && result.text.trim() === "NO_REPLY") return false;
  const child = (result.details as SubagentToolDetails).subagent;
  const timestamp = Date.now();
  const finalAssistant = stripThinkingFromAssistantMessage(result.finalAssistant);
  return appendResultMessages(
    parent,
    [
      {
        role: "custom",
        customType: "batty-subagent-result",
        content: `Subagent result\n\nDetached session: ${child.sessionPath}`,
        details: { subagent: child },
        timestamp,
      } as unknown as Message,
      {
        ...(finalAssistant ?? {
          role: "assistant",
          api: parent.model!.api,
          provider: parent.model!.provider,
          model: parent.model!.id,
        }),
        ...(result.isError || !finalAssistant
          ? { content: [{ type: "text", text: result.text || "(no output)" }] }
          : {}),
        usage: ZERO_USAGE,
        stopReason: result.isError ? "error" : "stop",
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
        timestamp: timestamp + 1,
      } as AssistantMessage,
    ],
    subagentReplyId(result),
  );
}

function subagentReplyId(result: DetachedSubagentResult): string {
  const child = (result.details as SubagentToolDetails).subagent;
  return `subagent:${child.sessionId}:${result.deliveryEntryId}`;
}

export async function deliverAsyncSubagentResult(
  parent: AgentSession,
  result: DetachedSubagentResult,
  onAccepted?: () => void,
): Promise<void> {
  const replyId = subagentReplyId(result);
  if (hasDeliveredResult(parent, replyId)) {
    onAccepted?.();
    return;
  }
  const child = (result.details as SubagentToolDetails).subagent;
  const status = result.isError ? "failed" : "completed";
  const output = result.text.trim() || "(no output)";
  const artifacts = result.details as SubagentToolDetails & {
    battyFileChanges?: DurableFileChange[];
    sentFiles?: SentFileDescriptor[];
    sites?: SiteDescriptor[];
  };
  await parent.sendCustomMessage(
    {
      customType: "batty-runtime-notice:subagent",
      content: [
        `Async subagent ${status}.`,
        "",
        `Detached session: ${child.sessionPath}`,
        "",
        "Assigned task:",
        child.prompt,
        "",
        result.isError ? "Error:" : "Result:",
        output,
      ].join("\n"),
      display: true,
      details: {
        battyResultReplyId: replyId,
        subagent: child,
        ...(artifacts.battyFileChanges?.length
          ? { battyFileChanges: artifacts.battyFileChanges }
          : {}),
        ...(artifacts.sentFiles?.length ? { sentFiles: artifacts.sentFiles } : {}),
        ...(artifacts.sites?.length ? { sites: artifacts.sites } : {}),
      },
    },
    { triggerTurn: true, steerWhenBusy: true, onAccepted },
  );
}

export async function appendMessages(session: AgentSession, messages: Message[]): Promise<void> {
  for (const message of messages) await session.sessionManager.appendMessage(message);
  session.sdk.refreshContext();
}

export interface ResolveDailySessionDeps {
  config: Pick<AppConfig, "cronDailySessionStartTime">;
  cronSessionResolutions: Map<string, Promise<SessionState>>;
  sessions: Map<string, WebSession>;
  listSessionSummaries: (workspace: WorkspaceInfo) => Promise<SessionSummary[]>;
  openSession: (workspace: WorkspaceInfo, sessionPath: string) => Promise<SessionState>;
  createSession: (
    workspace: WorkspaceInfo,
    options?: { modelId?: string; thinkingLevel?: string; ephemeral?: boolean },
  ) => Promise<SessionState>;
  requireSession: (sessionId: string) => WebSession;
  refreshBattySystemPrompt: (webSession: WebSession) => Promise<void>;
  notifyWorkspaceUpdated: (workspaceId: string) => Promise<void>;
  getState: (sessionId: string) => SessionState;
}

interface AppConfig {
  cronDailySessionStartTime: string;
}

export async function resolveOrCreateDailySession(
  deps: ResolveDailySessionDeps,
  workspace: WorkspaceInfo,
  options?: { modelId?: string; thinkingLevel?: string },
): Promise<SessionState> {
  const now = new Date();
  const date = toLocalIsoDate(now, deps.config.cronDailySessionStartTime);
  const key = `${workspace.id}:daily:${date}`;
  const inFlight = deps.cronSessionResolutions.get(key);
  if (inFlight) {
    return inFlight;
  }

  let resolution: Promise<SessionState>;
  resolution = (async () => {
    const todayStartMs = localDayStartMs(now, deps.config.cronDailySessionStartTime);
    const candidates = (await deps.listSessionSummaries(workspace)).filter(
      (candidate) =>
        typeof candidate.path === "string" &&
        candidate.path.length > 0 &&
        candidate.updatedAt >= todayStartMs,
    );

    for (const candidate of candidates) {
      const sessionPath = candidate.path;
      if (!sessionPath) {
        continue;
      }

      const loaded = [...deps.sessions.values()].find(
        (session) =>
          session.workspace.id === workspace.id && session.session.sessionFile === sessionPath,
      );
      const entries = loaded
        ? loaded.session.sessionManager.getEntries()
        : (await SessionManager.read(sessionPath)).entries;
      if (hasSubagentSessionMarker(entries)) {
        continue;
      }

      if (findDailyCronSessionBinding(entries, date)) {
        return deps.openSession(workspace, sessionPath);
      }
    }

    const session = await deps.createSession(workspace, {
      ...(options?.modelId ? { modelId: options.modelId } : {}),
      ...(options?.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    });
    const webSession = deps.requireSession(session.id);
    await webSession.session.sessionManager.appendCustomEntry(
      CRON_SESSION_CUSTOM_TYPE,
      buildDailyCronSessionBinding(now, deps.config.cronDailySessionStartTime),
    );
    await deps.refreshBattySystemPrompt(webSession);
    await deps.notifyWorkspaceUpdated(workspace.id);
    return deps.getState(webSession.id);
  })();

  deps.cronSessionResolutions.set(key, resolution);
  try {
    return await resolution;
  } finally {
    if (deps.cronSessionResolutions.get(key) === resolution) {
      deps.cronSessionResolutions.delete(key);
    }
  }
}
