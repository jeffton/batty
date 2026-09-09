import { type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BACKGROUND_CONTEXT as nativeContext,
  getOrThrow,
  HarnessClosed,
  HarnessFault,
} from "@earendil-works/pi-agent-core";
import { appendResultDelivery } from "./session-result-delivery";
import { HarnessSessionStore as SessionManager } from "./harness-session-store";
import type { HarnessController as AgentSession } from "./harness-controller";
import type {
  SessionState,
  SessionSummary,
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
  recoverOnly?: boolean;
  workspace: WorkspaceInfo;
  parentSessionId: string;
  parentSessionPath?: string;
  parentSubagentDepth: number;
  contextBranchLeafId?: string | null;
  prompt: string;
  modelId: string;
  thinkingLevel: string;
  includeSessionContext: boolean;
  respondIn: "tool-call" | "session";
  preludeNotices?: RuntimeNotice[];
  currentToolCallId?: string;
  signal?: AbortSignal;
  onUpdate?: (partial: {
    content: Array<{ type: "text"; text: string }>;
    details: ToolExecutionDetails;
  }) => void;
}

export function findDetachedSubagentDeliveryRequest(
  entries: ReturnType<SessionManager["getEntries"]>,
  sessionId: string,
): DetachedSubagentOptions | undefined {
  const marker = entries.findLast(
    (entry) => entry.type === "custom" && entry.customType === SUBAGENT_SESSION_CUSTOM_TYPE,
  );
  if (marker?.type !== "custom") return undefined;
  const data = marker.data as unknown as {
    sessionId: string;
    respondIn: string;
    request?: DetachedSubagentOptions;
  };
  return data.sessionId === sessionId && data.respondIn === "session" ? data.request : undefined;
}

export interface DetachedSubagentResult {
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
): DetachedSubagentResult {
  const messages = structuredClone(subagentSession.messages) as AgentSession["messages"];
  const generatedMessages =
    generatedMessagesOverride ?? newlyGeneratedSubagentMessages(messages, seedMessageCount);
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
      includeSessionContext: options.includeSessionContext,
      respondIn: options.respondIn,
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
): Promise<SessionManager> {
  if (options.sessionId) {
    const existing = await SessionManager.existing(
      options.workspace.path,
      deps.workspaceSessionDir,
      options.sessionId,
    );
    if (existing) return existing;
  }
  if (!options.includeSessionContext) {
    return SessionManager.create(
      options.workspace.path,
      deps.workspaceSessionDir,
      options.parentSessionId,
      options.sessionId,
    );
  }
  if (!options.parentSessionPath) {
    throw new Error("Cannot include session context without a persisted parent session");
  }

  const sourceManager = await SessionManager.open(options.parentSessionPath);
  const leafId = resolveDetachedContextLeafId(sourceManager, options);
  return sourceManager.fork(deps.workspaceSessionDir, leafId ?? null, options.sessionId);
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
  const manager = await createDetachedSubagentSessionManager(deps, options);
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
  if (!existing)
    await subagentSession.sessionManager.appendCustomEntry(SUBAGENT_SESSION_CUSTOM_TYPE, {
      sessionId: subagentSession.sessionId,
      parentSessionId: options.parentSessionId,
      depth: options.parentSubagentDepth + 1,
      respondIn: options.respondIn,
      request: {
        workspace: options.workspace,
        parentSessionId: options.parentSessionId,
        ...(options.parentSessionPath ? { parentSessionPath: options.parentSessionPath } : {}),
        parentSubagentDepth: options.parentSubagentDepth,
        prompt: options.prompt,
        modelId: options.modelId,
        thinkingLevel: options.thinkingLevel,
        includeSessionContext: options.includeSessionContext,
        respondIn: options.respondIn,
      },
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

  options.onUpdate?.({
    content: [],
    details: buildSubagentDetails(
      {
        prompt: options.prompt,
        model: options.modelId,
        effort: options.thinkingLevel,
        includeSessionContext: options.includeSessionContext,
        respondIn: options.respondIn,
      },
      subagentSession.messages,
      undefined,
      {
        generatedMessages: newlyGeneratedSubagentMessages(
          subagentSession.messages,
          seedMessageCount,
        ),
        workspaceId: options.workspace.id,
        sessionId: subagentSession.sessionId,
        sessionPath: subagentSession.sessionFile,
      },
    ),
  });

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
          includeSessionContext: options.includeSessionContext,
          respondIn: options.respondIn,
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
    const closing =
      options.signal?.reason instanceof HarnessClosed ||
      options.signal?.reason instanceof HarnessFault;
    const operation = closing ? subagentSession.dispose() : subagentSession.abort();
    void operation.catch((error) => console.error("Failed to stop subagent", error));
  };
  if (options.signal) {
    if (options.signal.aborted) {
      abortListener();
    } else {
      options.signal.addEventListener("abort", abortListener, { once: true });
    }
  }

  let deliveringResult = false;
  try {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Subagent aborted");
    }
    if (subagentSession.isStreaming) await subagentSession.resume();
    else if (!subagentSession.snapshot.lastResult) {
      if (options.recoverOnly)
        throw new Error("Batty stopped before this subagent operation was admitted");
      getOrThrow(
        await subagentSession.lane.accept(
          {
            kind: "prompt",
            prompt: buildRuntimeNoticeMessage(subagentNotice, Date.now()),
          },
          nativeContext,
        ),
      );
      await subagentSession.resume();
    }
    const branch = subagentSession.sessionManager.getBranch();
    const marker = branch.findLastIndex(
      (entry) => entry.type === "custom" && entry.customType === SUBAGENT_SESSION_CUSTOM_TYPE,
    );
    const generated = branch
      .slice(marker + 1)
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    const result = buildDetachedSubagentResult(
      subagentSession,
      options,
      seedMessageCount,
      subagentSession.snapshot.lastResult?.status === "failed"
        ? subagentSession.snapshot.lastResult.error!.message
        : subagentSession.snapshot.lastResult?.status === "aborted"
          ? "Subagent stopped by user"
          : undefined,
      observedFinalAssistant,
      generated,
    );
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
    if (error instanceof HarnessClosed || error instanceof HarnessFault) throw error;
    // Delivery failures remain retryable; they must not replace the child's native result.
    if (
      deliveringResult ||
      subagentSession.isStreaming ||
      (options.recoverOnly && !subagentSession.snapshot.lastResult)
    )
      throw error;
    const result = buildDetachedSubagentResult(
      subagentSession,
      options,
      seedMessageCount,
      error instanceof Error ? error.message : String(error),
      observedFinalAssistant,
      observedGeneratedMessages.length > 0 ? observedGeneratedMessages : undefined,
    );
    if (options.respondIn === "session" && subagentSession.snapshot.lastResult) {
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
  return appendResultDelivery(parent, `subagent:${child.sessionId}`, [
    {
      role: "custom",
      customType: "batty-subagent-result",
      content: `Subagent result\n\nDetached session: ${child.sessionPath}`,
      data: { subagent: child },
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
  ]);
}

export async function appendMessages(session: AgentSession, messages: Message[]): Promise<void> {
  for (const message of messages) await session.sessionManager.appendMessage(message);
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
