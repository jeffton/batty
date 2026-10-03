import {
  abortSession,
  createOrOpenDailySession,
  createSession,
  getSession,
  getSessionMessages,
  markSessionRead,
  openSession,
  openSessionById,
  removeQueuedPrompt as removeQueuedPromptRequest,
  sendPrompt,
  setSessionModel,
  setSessionThinkingLevel,
} from "@/client/lib/api";
import { readCachedSession, writeCachedSession } from "@/client/lib/cache";
import { primeAgentNotifications } from "@/client/lib/agent-notifications";
import { syncPushSubscription } from "@/client/lib/push-notifications";
import { applyServerEvent, shouldWriteSessionCache } from "@/client/lib/session-events";
import { mergeSessionSnapshot } from "@/client/lib/session-state";
import { presentSession } from "@/client/lib/session-presentation";
import { sessionEventsPath } from "@/client/lib/session-stream";
import { mergeSessionSummaries, toSessionSummary } from "@/client/lib/session-summary";
import { RECENT_SESSION_MESSAGE_WINDOW } from "@/shared/session-history";
import type {
  PromptSubmissionResult,
  ServerEvent,
  SessionSnapshot,
  SessionState,
} from "@/shared/types";
import { closeEventSource, type AppActionContext } from "./app-state";

let eventSource: EventSource | undefined;
let eventSourceSessionId: string | undefined;
let eventSourceOwnerState: unknown;
let selectionGeneration = 0;
let connectionGeneration = 0;
let streamUpdateGeneration = 0;
const sessionOpenRequests = new Map<string, Promise<SessionSnapshot>>();
const sessionDetailRequests = new Map<string, Promise<void>>();
const sessionDetailTimers = new Map<string, ReturnType<typeof setTimeout>>();
let modelUpdateVersion = 0;
let thinkingLevelUpdateVersion = 0;
let sessionConfigurationUpdateQueue = Promise.resolve();

async function runSessionConfigurationUpdate<T>(update: () => Promise<T>): Promise<T> {
  const result = sessionConfigurationUpdateQueue.then(update, update);
  sessionConfigurationUpdateQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function acknowledgeVisibleReplies(session: SessionState): Promise<void> {
  const readThrough = session.messages.reduce(
    (latest, message) =>
      message.role === "assistant" ? Math.max(latest, message.timestamp) : latest,
    0,
  );
  if (readThrough) await markSessionRead(session.workspaceId, session.sessionId, readThrough);
}

function streamOwnsSession(context: AppActionContext, snapshot: SessionSnapshot): boolean {
  return Boolean(
    eventSource &&
    eventSourceOwnerState === context.$state &&
    eventSourceSessionId === snapshot.metadata.sessionId,
  );
}

function primeNotifications(): void {
  void primeAgentNotifications().then((granted) => {
    if (granted) void syncPushSubscription(false);
  });
}

export const sessionActions = {
  closeStream(): void {
    ++connectionGeneration;
    closeEventSource(eventSource);
    eventSource = undefined;
    eventSourceSessionId = undefined;
    eventSourceOwnerState = undefined;
  },

  updateSessionSummary(this: AppActionContext, session: SessionState): void {
    if (!session.path) return;
    this.sessionsByWorkspace = {
      ...this.sessionsByWorkspace,
      [session.workspaceId]: mergeSessionSummaries(
        this.sessionsByWorkspace[session.workspaceId] ?? [],
        [toSessionSummary(session)],
      ),
    };
    this.sortWorkspaces();
  },

  async startSession(this: AppActionContext, workspaceId: string): Promise<SessionState> {
    const snapshot = await createSession(workspaceId);
    await this.selectSession(snapshot);
    return presentSession(snapshot)!;
  },

  async startDailySession(this: AppActionContext, workspaceId: string): Promise<SessionState> {
    const snapshot = await createOrOpenDailySession(workspaceId);
    await this.selectSession(snapshot);
    return presentSession(snapshot)!;
  },

  async resumeSession(
    this: AppActionContext,
    workspaceId: string,
    sessionPath: string,
    options: { shouldSelect?: () => boolean } = {},
  ): Promise<SessionState> {
    return this.resumeOpenedSession(() => openSession(workspaceId, sessionPath), options);
  },

  async resumeSessionById(
    this: AppActionContext,
    workspaceId: string,
    sessionId: string,
    options: { shouldSelect?: () => boolean } = {},
  ): Promise<SessionState> {
    const key = `${workspaceId}:${sessionId}`;
    let opening = sessionOpenRequests.get(key);
    if (!opening) {
      opening = openSessionById(workspaceId, sessionId);
      sessionOpenRequests.set(key, opening);
    }
    try {
      return await this.resumeOpenedSession(() => opening!, options);
    } finally {
      if (sessionOpenRequests.get(key) === opening) sessionOpenRequests.delete(key);
    }
  },

  async resumeOpenedSession(
    this: AppActionContext,
    opener: () => Promise<SessionSnapshot>,
    options: { shouldSelect?: () => boolean } = {},
  ): Promise<SessionState> {
    const opened = await opener();
    const cached = await readCachedSession(opened.metadata.sessionId);
    const current = this.activeSnapshot;
    const snapshot =
      current &&
      current.metadata.sessionId === opened.metadata.sessionId &&
      streamOwnsSession(this, current)
        ? current
        : mergeSessionSnapshot(opened, cached);
    if (options.shouldSelect?.() !== false) await this.selectSession(snapshot);
    return presentSession(snapshot)!;
  },

  async selectSession(
    this: AppActionContext,
    snapshot: SessionSnapshot,
    options: { openStream?: boolean } = {},
  ): Promise<void> {
    const current = this.activeSnapshot;
    if (
      current &&
      current.metadata.sessionId === snapshot.metadata.sessionId &&
      streamOwnsSession(this, current)
    )
      snapshot = current;
    ++selectionGeneration;
    this.activeSnapshot = snapshot;
    const session = presentSession(snapshot)!;
    this.selectedWorkspaceId = session.workspaceId;
    this.updateSessionSummary(session);
    if (options.openStream !== false) this.openStream(session);
    else this.closeStream();
    await Promise.all([writeCachedSession(snapshot), acknowledgeVisibleReplies(session)]);
    if (session.messagesDetailLevel === "summary") this.scheduleSessionEnhancement(session);
  },

  clearActiveSession(this: AppActionContext): void {
    ++selectionGeneration;
    this.closeStream();
    this.activeSnapshot = undefined;
  },

  setRouteLoading(this: AppActionContext, workspaceId?: string, sessionId?: string): void {
    this.routeLoadingWorkspaceId = workspaceId;
    this.routeLoadingSessionId = sessionId;
  },

  clearRouteLoading(this: AppActionContext): void {
    this.routeLoadingWorkspaceId = undefined;
    this.routeLoadingSessionId = undefined;
  },

  openStream(
    this: AppActionContext,
    session: Pick<SessionState, "id" | "sessionId" | "workspaceId" | "path">,
  ): void {
    if (
      eventSource &&
      eventSourceOwnerState === this.$state &&
      eventSourceSessionId === session.sessionId
    )
      return;
    this.closeStream();
    this.connectionState = "connecting";
    const source = new EventSource(sessionEventsPath(session));
    eventSource = source;
    eventSourceSessionId = session.sessionId;
    eventSourceOwnerState = this.$state;
    let hydrated = false;
    source.onopen = () => {
      if (eventSource !== source) return;
      ++connectionGeneration;
      hydrated = false;
      this.connectionState = "online";
      void this.checkForClientUpdate();
    };
    source.onmessage = (message) => {
      if (eventSource !== source || this.activeSnapshot?.metadata.sessionId !== session.sessionId)
        return;
      const event = JSON.parse(message.data) as ServerEvent;
      if (event.type === "error") {
        this.lastError = event.message;
        return;
      }
      if (event.type === "session") hydrated = true;
      else if (!hydrated) return;
      const previous = this.activeSnapshot;
      const next = applyServerEvent(previous, event)!;
      ++streamUpdateGeneration;
      this.activeSnapshot = next;
      const presentation = presentSession(next)!;
      this.updateSessionSummary(presentation);
      if (presentation.messagesDetailLevel === "summary")
        this.scheduleSessionEnhancement(presentation);
      if (shouldWriteSessionCache(event, previous, next)) void writeCachedSession(next);
      if (event.type === "session" && !presentation.isStreaming)
        void acknowledgeVisibleReplies(presentation);
      this.connectionState = "online";
    };
    source.onerror = () => {
      if (eventSource !== source) return;
      this.connectionState = navigator.onLine ? "connecting" : "offline";
    };
  },

  async refreshActiveSession(this: AppActionContext): Promise<void> {
    const requested = this.activeSnapshot;
    if (!requested) return;
    const selected = selectionGeneration;
    const connection = connectionGeneration;
    const streamUpdate = streamUpdateGeneration;
    const response = await getSession(requested.metadata.id);
    const current = this.activeSnapshot;
    if (
      !current ||
      selected !== selectionGeneration ||
      connection !== connectionGeneration ||
      current.metadata.sessionId !== requested.metadata.sessionId ||
      response.historyVersion < current.historyVersion
    )
      return;
    // HTTP can be ahead of queued SSE frames even when no event arrived during the request.
    const streamOwned = streamOwnsSession(this, current);
    if (
      streamOwned &&
      (response.historyVersion !== requested.historyVersion ||
        current.historyVersion !== requested.historyVersion)
    )
      return;
    const merged = mergeSessionSnapshot(response, current);
    this.activeSnapshot =
      !streamOwned && streamUpdate === streamUpdateGeneration
        ? merged
        : {
            ...current,
            messages: merged.messages,
            historyVersion: merged.historyVersion,
            metadata: {
              ...current.metadata,
              totalMessageCount: merged.metadata.totalMessageCount,
              hasMoreMessages: merged.metadata.hasMoreMessages,
              messagesDetailLevel: merged.metadata.messagesDetailLevel,
            },
          };
    this.updateSessionSummary(this.activeSession!);
    await writeCachedSession(this.activeSnapshot!);
  },

  scheduleSessionEnhancement(
    this: AppActionContext,
    session: Pick<SessionState, "id" | "sessionId">,
  ): void {
    const existing = sessionDetailTimers.get(session.sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      sessionDetailTimers.delete(session.sessionId);
      void this.enhanceSessionMessages(session);
    }, 500);
    sessionDetailTimers.set(session.sessionId, timer);
  },

  async enhanceSessionMessages(
    this: AppActionContext,
    session: Pick<SessionState, "id" | "sessionId">,
  ): Promise<void> {
    const existing = sessionDetailRequests.get(session.sessionId);
    if (existing) return existing;
    const selected = selectionGeneration;
    const connection = connectionGeneration;
    const requested = this.activeSnapshot;
    if (!requested || requested.metadata.sessionId !== session.sessionId) return;
    const throughEntryId = requested.historyVersion;
    const request = (async () => {
      const detailed = await getSessionMessages(requested.metadata, {
        throughEntryId,
        limit: Math.max(RECENT_SESSION_MESSAGE_WINDOW, requested.messages.length),
      });
      const current = this.activeSnapshot;
      if (
        !current ||
        current.metadata.sessionId !== session.sessionId ||
        selected !== selectionGeneration ||
        connection !== connectionGeneration ||
        detailed.historyVersion !== throughEntryId ||
        current.historyVersion !== throughEntryId
      )
        return;
      const merged = mergeSessionSnapshot(
        {
          ...current,
          messages: detailed.messages,
          metadata: { ...current.metadata, messagesDetailLevel: "full" },
        },
        current,
      );
      this.activeSnapshot = {
        ...current,
        messages: merged.messages,
        metadata: { ...current.metadata, messagesDetailLevel: "full" },
      };
      await writeCachedSession(this.activeSnapshot!);
    })();
    sessionDetailRequests.set(session.sessionId, request);
    try {
      await request;
    } finally {
      if (sessionDetailRequests.get(session.sessionId) === request)
        sessionDetailRequests.delete(session.sessionId);
    }
  },

  async loadOlderMessages(this: AppActionContext): Promise<void> {
    const snapshot = this.activeSnapshot;
    const session = this.activeSession;
    if (
      !snapshot ||
      !session ||
      this.loadingOlderMessages ||
      !session.hasMoreMessages ||
      !session.messages.length
    )
      return;
    const selected = selectionGeneration;
    const connection = connectionGeneration;
    this.loadingOlderMessages = true;
    try {
      const page = await getSessionMessages(session, {
        before: session.messages[0]!.id,
        limit: RECENT_SESSION_MESSAGE_WINDOW,
        throughEntryId: snapshot.historyVersion,
      });
      const current = this.activeSnapshot;
      if (
        !current ||
        selected !== selectionGeneration ||
        connection !== connectionGeneration ||
        current.metadata.sessionId !== session.sessionId ||
        page.historyVersion !== snapshot.historyVersion ||
        current.historyVersion !== snapshot.historyVersion ||
        current.messages[0]?.id !== snapshot.messages[0]?.id
      )
        return;
      const ids = new Set(current.messages.map((message) => message.id));
      this.activeSnapshot = {
        ...current,
        messages: [...page.messages.filter((message) => !ids.has(message.id)), ...current.messages],
        historyVersion: page.historyVersion,
        metadata: {
          ...current.metadata,
          totalMessageCount: page.totalMessageCount,
          hasMoreMessages: page.hasMoreMessages,
        },
      };
      this.updateSessionSummary(this.activeSession!);
      await writeCachedSession(this.activeSnapshot!);
    } finally {
      this.loadingOlderMessages = false;
    }
  },

  async sendPrompt(
    this: AppActionContext,
    text: string,
    files: File[],
    clientMessageId: string,
  ): Promise<PromptSubmissionResult | undefined> {
    if (!this.activeSession) return;
    primeNotifications();
    return sendPrompt(
      this.activeSession.id,
      text,
      files,
      clientMessageId,
      this.activeSession.isStreaming ? "followUp" : undefined,
    );
  },

  async steerPrompt(
    this: AppActionContext,
    text: string,
    files: File[],
    clientMessageId: string,
  ): Promise<PromptSubmissionResult | undefined> {
    if (!this.activeSession) return;
    primeNotifications();
    return sendPrompt(this.activeSession.id, text, files, clientMessageId, "steer");
  },

  async removeQueuedPrompt(this: AppActionContext, submissionId: number): Promise<void> {
    const requested = this.activeSnapshot;
    if (!requested) return;
    const selected = selectionGeneration;
    const connection = connectionGeneration;
    const response = await removeQueuedPromptRequest(requested.metadata.id, submissionId);
    if (
      selected !== selectionGeneration ||
      connection !== connectionGeneration ||
      this.activeSnapshot !== requested
    )
      return;
    if (streamOwnsSession(this, requested)) return;
    this.activeSnapshot = mergeSessionSnapshot(response, requested);
    this.updateSessionSummary(this.activeSession!);
    await writeCachedSession(this.activeSnapshot!);
  },

  async setModel(this: AppActionContext, modelId: string): Promise<void> {
    const version = ++modelUpdateVersion;
    const streamUpdate = streamUpdateGeneration;
    const requested = this.activeSnapshot;
    const selected = selectionGeneration;
    if (!requested) return;
    const response = await runSessionConfigurationUpdate(() =>
      setSessionModel(requested.metadata.id, modelId),
    );
    if (
      version !== modelUpdateVersion ||
      selected !== selectionGeneration ||
      this.activeSnapshot?.metadata.sessionId !== requested.metadata.sessionId
    )
      return;
    this.activeSnapshot =
      !streamOwnsSession(this, this.activeSnapshot) && streamUpdate === streamUpdateGeneration
        ? mergeSessionSnapshot(response, this.activeSnapshot)
        : {
            ...this.activeSnapshot,
            metadata: {
              ...this.activeSnapshot.metadata,
              model: response.metadata.model,
              modelLabel: response.metadata.modelLabel,
              thinkingLevel: response.metadata.thinkingLevel,
              availableThinkingLevels: response.metadata.availableThinkingLevels,
            },
          };
    this.updateSessionSummary(this.activeSession!);
    await writeCachedSession(this.activeSnapshot!);
  },

  async setThinkingLevel(this: AppActionContext, thinkingLevel: string): Promise<void> {
    const version = ++thinkingLevelUpdateVersion;
    const streamUpdate = streamUpdateGeneration;
    const requested = this.activeSnapshot;
    const selected = selectionGeneration;
    if (!requested) return;
    const response = await runSessionConfigurationUpdate(() =>
      setSessionThinkingLevel(requested.metadata.id, thinkingLevel),
    );
    if (
      version !== thinkingLevelUpdateVersion ||
      selected !== selectionGeneration ||
      this.activeSnapshot?.metadata.sessionId !== requested.metadata.sessionId
    )
      return;
    this.activeSnapshot =
      !streamOwnsSession(this, this.activeSnapshot) && streamUpdate === streamUpdateGeneration
        ? mergeSessionSnapshot(response, this.activeSnapshot)
        : {
            ...this.activeSnapshot,
            metadata: {
              ...this.activeSnapshot.metadata,
              thinkingLevel: response.metadata.thinkingLevel,
              availableThinkingLevels: response.metadata.availableThinkingLevels,
            },
          };
    this.updateSessionSummary(this.activeSession!);
    await writeCachedSession(this.activeSnapshot!);
  },

  async stopActiveSession(this: AppActionContext): Promise<void> {
    const requested = this.activeSession;
    if (!requested) return;
    await abortSession(requested.id);
    if (this.activeSession?.sessionId === requested.sessionId) await this.refreshActiveSession();
  },
};
