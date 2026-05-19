import {
  abortSession,
  createOrOpenDailySession,
  createSession,
  getSession,
  getSessionMessages,
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
import {
  applyServerEvent,
  shouldUpdateSessionSummary,
  shouldWriteSessionCache,
} from "@/client/lib/session-events";
import { mergeSessionState, normalizeSessionState } from "@/client/lib/session-state";
import { sessionEventsPath } from "@/client/lib/session-stream";
import { mergeSessionSummaries, toSessionSummary } from "@/client/lib/session-summary";
import { RECENT_SESSION_MESSAGE_WINDOW } from "@/shared/session-history";
import type { ServerEvent, SessionState } from "@/shared/types";
import { closeEventSource, type AppActionContext } from "./app-state";

let eventSource: EventSource | undefined;

function prependUniqueMessages(
  existing: SessionState["messages"],
  older: SessionState["messages"],
): SessionState["messages"] {
  if (older.length === 0) {
    return existing;
  }

  const existingIds = new Set(existing.map((message) => message.id));
  return [...older.filter((message) => !existingIds.has(message.id)), ...existing];
}

export const sessionActions = {
  closeStream(): void {
    closeEventSource(eventSource);
    eventSource = undefined;
  },

  updateSessionSummary(this: AppActionContext, session: SessionState): void {
    if (!session.path) {
      return;
    }

    const workspaceSessions = this.sessionsByWorkspace[session.workspaceId] ?? [];
    this.sessionsByWorkspace = {
      ...this.sessionsByWorkspace,
      [session.workspaceId]: mergeSessionSummaries(workspaceSessions, [toSessionSummary(session)]),
    };
    this.sortWorkspaces();
  },

  async startSession(this: AppActionContext, workspaceId: string): Promise<SessionState> {
    const session = normalizeSessionState(await createSession(workspaceId));
    if (!session) {
      throw new Error("Failed to create session");
    }
    await this.selectSession(session);
    await this.loadWorkspaceSessions(workspaceId);
    return session;
  },

  async startDailySession(this: AppActionContext, workspaceId: string): Promise<SessionState> {
    const session = normalizeSessionState(await createOrOpenDailySession(workspaceId));
    if (!session) {
      throw new Error("Failed to open daily session");
    }
    await this.selectSession(session);
    await this.loadWorkspaceSessions(workspaceId);
    return session;
  },

  async resumeSession(
    this: AppActionContext,
    workspaceId: string,
    sessionPath: string,
  ): Promise<SessionState> {
    return this.resumeOpenedSession(() => openSession(workspaceId, sessionPath));
  },

  async resumeSessionById(
    this: AppActionContext,
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionState> {
    return this.resumeOpenedSession(() => openSessionById(workspaceId, sessionId));
  },

  async resumeOpenedSession(
    this: AppActionContext,
    opener: () => Promise<SessionState>,
  ): Promise<SessionState> {
    try {
      const openedSession = normalizeSessionState(await opener());
      if (!openedSession) {
        throw new Error("Failed to open session");
      }
      const cached = await readCachedSession(openedSession.sessionId);
      const session = mergeSessionState(openedSession, cached);
      if (!session) {
        throw new Error("Failed to open session");
      }
      await this.selectSession(session);
      return session;
    } catch (error) {
      const cached = this.activeSession?.sessionId
        ? await readCachedSession(this.activeSession.sessionId)
        : undefined;
      if (cached) {
        this.activeSession = cached;
      }
      throw error;
    }
  },

  async selectSession(
    this: AppActionContext,
    session: SessionState,
    options: { openStream?: boolean } = {},
  ): Promise<void> {
    const { openStream = true } = options;

    this.activeSession = session;
    this.selectedWorkspaceId = session.workspaceId;
    this.updateSessionSummary(session);
    await writeCachedSession(session);
    if (openStream) {
      this.openStream(session);
    } else {
      this.closeStream();
    }
  },

  clearActiveSession(this: AppActionContext): void {
    this.closeStream();
    this.activeSession = undefined;
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
    this.closeStream();
    this.connectionState = "connecting";
    const source = new EventSource(sessionEventsPath(session));
    eventSource = source;
    source.onopen = () => {
      if (eventSource !== source) {
        return;
      }

      this.connectionState = "online";
      void this.checkForClientUpdate();
    };
    source.onmessage = async (message) => {
      if (eventSource !== source) {
        return;
      }

      const currentSession = this.activeSession;
      if (!currentSession || currentSession.sessionId !== session.sessionId) {
        return;
      }

      const event = JSON.parse(message.data) as ServerEvent;
      const nextSession = applyServerEvent(currentSession, event);
      if (!nextSession || nextSession.sessionId !== session.sessionId) {
        return;
      }

      this.activeSession = nextSession;
      if (shouldUpdateSessionSummary(event)) {
        this.updateSessionSummary(nextSession);
      }
      if (shouldWriteSessionCache(event)) {
        await writeCachedSession(nextSession);
      }
      this.connectionState = "online";
    };
    source.onerror = async () => {
      if (eventSource !== source) {
        return;
      }

      this.connectionState = navigator.onLine ? "connecting" : "offline";
      if (this.activeSession?.sessionId === session.sessionId) {
        const cached = await readCachedSession(session.sessionId);
        if (cached) {
          this.activeSession = cached;
        }
      }
    };
  },

  async refreshActiveSession(this: AppActionContext): Promise<void> {
    if (!this.activeSession) {
      return;
    }
    const session = mergeSessionState(
      normalizeSessionState(await getSession(this.activeSession.id)),
      this.activeSession,
    );
    if (!session) {
      throw new Error("Failed to refresh session");
    }
    this.activeSession = session;
    this.updateSessionSummary(session);
    await writeCachedSession(session);
  },

  async loadOlderMessages(this: AppActionContext): Promise<void> {
    const session = this.activeSession;
    if (
      !session ||
      this.loadingOlderMessages ||
      !session.hasMoreMessages ||
      session.messages.length === 0
    ) {
      return;
    }

    this.loadingOlderMessages = true;
    try {
      const before = session.messages[0]?.id;
      const page = await getSessionMessages(session, {
        ...(before ? { before } : {}),
        limit: RECENT_SESSION_MESSAGE_WINDOW,
      });
      const nextSession = normalizeSessionState({
        ...session,
        messages: prependUniqueMessages(session.messages, page.messages),
        totalMessageCount: page.totalMessageCount,
        hasMoreMessages: page.hasMoreMessages,
      });
      if (!nextSession) {
        throw new Error("Failed to load older messages");
      }

      this.activeSession = nextSession;
      this.updateSessionSummary(nextSession);
      await writeCachedSession(nextSession);
    } finally {
      this.loadingOlderMessages = false;
    }
  },

  async sendPrompt(this: AppActionContext, text: string, files: File[]): Promise<void> {
    if (!this.activeSession) {
      return;
    }
    void primeAgentNotifications().then((granted) => {
      if (granted) {
        void syncPushSubscription(false);
      }
    });
    await sendPrompt(
      this.activeSession.id,
      text,
      files,
      this.activeSession.isStreaming ? "followUp" : undefined,
    );
  },

  async steerPrompt(this: AppActionContext, text: string, files: File[]): Promise<void> {
    if (!this.activeSession) {
      return;
    }
    void primeAgentNotifications().then((granted) => {
      if (granted) {
        void syncPushSubscription(false);
      }
    });
    await sendPrompt(this.activeSession.id, text, files, "steer");
  },

  async removeQueuedPrompt(
    this: AppActionContext,
    kind: "steer" | "followUp",
    index: number,
  ): Promise<void> {
    if (!this.activeSession) {
      return;
    }
    const session = normalizeSessionState(
      await removeQueuedPromptRequest(this.activeSession.id, kind, index),
    );
    if (!session) {
      throw new Error("Failed to remove queued prompt");
    }
    const merged = mergeSessionState(session, this.activeSession);
    if (!merged) {
      throw new Error("Failed to remove queued prompt");
    }
    this.activeSession = merged;
    this.updateSessionSummary(merged);
    await writeCachedSession(merged);
  },

  async setModel(this: AppActionContext, modelId: string): Promise<void> {
    if (!this.activeSession) {
      return;
    }
    const session = normalizeSessionState(await setSessionModel(this.activeSession.id, modelId));
    if (!session) {
      throw new Error("Failed to update model");
    }
    this.activeSession = session;
    this.updateSessionSummary(session);
    await writeCachedSession(session);
  },

  async setThinkingLevel(this: AppActionContext, thinkingLevel: string): Promise<void> {
    if (!this.activeSession) {
      return;
    }
    const session = normalizeSessionState(
      await setSessionThinkingLevel(this.activeSession.id, thinkingLevel),
    );
    if (!session) {
      throw new Error("Failed to update thinking level");
    }
    this.activeSession = session;
    this.updateSessionSummary(session);
    await writeCachedSession(session);
  },

  async stopActiveSession(this: AppActionContext): Promise<void> {
    if (!this.activeSession) {
      return;
    }
    await abortSession(this.activeSession.id);
    await this.refreshActiveSession();
  },
};
