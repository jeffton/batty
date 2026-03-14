import { defineStore } from "pinia";
import {
  abortSession,
  createSession,
  createWorkspace as createWorkspaceRequest,
  getBootstrap,
  getSession,
  listWorkspaceSessions,
  listWorkspaces as listWorkspacesRequest,
  login as loginRequest,
  logout as logoutRequest,
  openSession,
  sendPrompt,
  setSessionModel,
  setSessionThinkingLevel,
} from "@/client/lib/api";
import {
  readCachedBootstrap,
  readCachedSession,
  writeCachedBootstrap,
  writeCachedSession,
} from "@/client/lib/cache";
import { applyServerEvent } from "@/client/lib/session-events";
import { normalizeSessionState } from "@/client/lib/session-state";
import { mergeSessionSummaries, toSessionSummary } from "@/client/lib/session-summary";
import type {
  BootstrapPayload,
  ModelOption,
  ServerEvent,
  SessionState,
  SessionSummary,
  WorkspaceInfo,
} from "@/shared/types";

let eventSource: EventSource | undefined;

export const useAppStore = defineStore("app", {
  state: () => ({
    authenticated: false,
    bootstrapped: false,
    connectionState: "online" as "online" | "offline" | "connecting",
    workspaces: [] as WorkspaceInfo[],
    models: [] as ModelOption[],
    sessionsByWorkspace: {} as Record<string, SessionSummary[]>,
    activeSession: undefined as SessionState | undefined,
    selectedWorkspaceId: undefined as string | undefined,
    authError: undefined as string | undefined,
    lastError: undefined as string | undefined,
    mobileSidebarOpen: false,
  }),
  getters: {
    selectedWorkspace(state): WorkspaceInfo | undefined {
      return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
    },
    workspaceSessions(state): SessionSummary[] {
      if (!state.selectedWorkspaceId) {
        return [];
      }

      const sessions = state.sessionsByWorkspace[state.selectedWorkspaceId] ?? [];
      const activeSession =
        state.activeSession?.workspaceId === state.selectedWorkspaceId && state.activeSession.path
          ? [toSessionSummary(state.activeSession)]
          : [];

      return mergeSessionSummaries(sessions, activeSession);
    },
  },
  actions: {
    async bootstrap(): Promise<void> {
      this.connectionState = navigator.onLine ? "online" : "offline";
      try {
        const payload = await getBootstrap();
        this.applyBootstrap(payload);
        await writeCachedBootstrap(payload);
      } catch (error) {
        const cached = await readCachedBootstrap();
        if (cached) {
          this.applyBootstrap(cached);
          this.connectionState = "offline";
          this.lastError = error instanceof Error ? error.message : String(error);
        } else {
          throw error;
        }
      } finally {
        this.bootstrapped = true;
      }
    },

    applyBootstrap(payload: BootstrapPayload): void {
      this.authenticated = payload.authenticated;
      this.workspaces = payload.workspaces;
      this.models = payload.models;
      this.selectedWorkspaceId = this.selectedWorkspaceId ?? payload.workspaces[0]?.id;
      if (!payload.authenticated) {
        this.activeSession = undefined;
        this.sessionsByWorkspace = {};
        this.closeStream();
      }
    },

    async login(password: string): Promise<void> {
      this.authError = undefined;
      try {
        await loginRequest(password);
        await this.bootstrap();
      } catch (error) {
        this.authError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },

    async logout(): Promise<void> {
      await logoutRequest();
      this.closeStream();
      this.authenticated = false;
      this.activeSession = undefined;
      this.sessionsByWorkspace = {};
    },

    closeStream(): void {
      eventSource?.close();
      eventSource = undefined;
    },

    async loadWorkspaceSessions(workspaceId: string): Promise<void> {
      const sessions = await listWorkspaceSessions(workspaceId);
      const existing = this.sessionsByWorkspace[workspaceId] ?? [];
      const activeSession =
        this.activeSession?.workspaceId === workspaceId && this.activeSession.path
          ? [toSessionSummary(this.activeSession)]
          : [];

      this.sessionsByWorkspace = {
        ...this.sessionsByWorkspace,
        [workspaceId]: mergeSessionSummaries(sessions, existing, activeSession),
      };
    },

    selectWorkspace(workspaceId: string): void {
      this.selectedWorkspaceId = workspaceId;
      this.mobileSidebarOpen = false;
    },

    updateSessionSummary(session: SessionState): void {
      if (!session.path) {
        return;
      }

      const workspaceSessions = this.sessionsByWorkspace[session.workspaceId] ?? [];
      this.sessionsByWorkspace = {
        ...this.sessionsByWorkspace,
        [session.workspaceId]: mergeSessionSummaries(workspaceSessions, [
          toSessionSummary(session),
        ]),
      };
    },

    async createWorkspace(name: string): Promise<WorkspaceInfo> {
      const workspace = await createWorkspaceRequest(name);
      this.workspaces = await listWorkspacesRequest();
      this.sessionsByWorkspace = {
        ...this.sessionsByWorkspace,
        [workspace.id]: [],
      };
      this.selectWorkspace(workspace.id);
      await this.loadWorkspaceSessions(workspace.id);
      return workspace;
    },

    async startSession(workspaceId: string): Promise<SessionState> {
      const session = normalizeSessionState(await createSession(workspaceId));
      if (!session) {
        throw new Error("Failed to create session");
      }
      await this.selectSession(session);
      await this.loadWorkspaceSessions(workspaceId);
      return session;
    },

    async resumeSession(workspaceId: string, sessionPath: string): Promise<SessionState> {
      try {
        const session = normalizeSessionState(await openSession(workspaceId, sessionPath));
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

    async selectSession(session: SessionState): Promise<void> {
      this.activeSession = session;
      this.selectedWorkspaceId = session.workspaceId;
      this.updateSessionSummary(session);
      await writeCachedSession(session);
      this.openStream(session.id);
      this.mobileSidebarOpen = false;
    },

    clearActiveSession(): void {
      this.closeStream();
      this.activeSession = undefined;
      this.mobileSidebarOpen = false;
    },

    openStream(sessionId: string): void {
      this.closeStream();
      this.connectionState = "connecting";
      eventSource = new EventSource(`/api/sessions/${sessionId}/events`);
      eventSource.onmessage = async (message) => {
        const event = JSON.parse(message.data) as ServerEvent;
        this.activeSession = applyServerEvent(this.activeSession, event);
        if (this.activeSession) {
          this.updateSessionSummary(this.activeSession);
          await writeCachedSession(this.activeSession);
        }
        this.connectionState = "online";
      };
      eventSource.onerror = async () => {
        this.connectionState = navigator.onLine ? "connecting" : "offline";
        if (this.activeSession?.sessionId) {
          const cached = await readCachedSession(this.activeSession.sessionId);
          if (cached) {
            this.activeSession = cached;
          }
        }
      };
    },

    async refreshActiveSession(): Promise<void> {
      if (!this.activeSession) {
        return;
      }
      const session = normalizeSessionState(await getSession(this.activeSession.id));
      if (!session) {
        throw new Error("Failed to refresh session");
      }
      this.activeSession = session;
      this.updateSessionSummary(session);
      await writeCachedSession(session);
    },

    async sendPrompt(text: string, files: File[]): Promise<void> {
      if (!this.activeSession) {
        return;
      }
      await sendPrompt(
        this.activeSession.id,
        text,
        files,
        this.activeSession.isStreaming ? "followUp" : undefined,
      );
    },

    async steerPrompt(text: string, files: File[]): Promise<void> {
      if (!this.activeSession) {
        return;
      }
      await sendPrompt(this.activeSession.id, text, files, "steer");
    },

    async setModel(modelId: string): Promise<void> {
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

    async setThinkingLevel(thinkingLevel: string): Promise<void> {
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

    async stopActiveSession(): Promise<void> {
      if (!this.activeSession) {
        return;
      }
      await abortSession(this.activeSession.id);
      await this.refreshActiveSession();
    },

    markOffline(): void {
      this.connectionState = "offline";
    },

    markOnline(): void {
      this.connectionState = "online";
    },
  },
});
