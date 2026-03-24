import { defineStore } from "pinia";
import {
  abortSession,
  createSession,
  createWorkspace as createWorkspaceRequest,
  deleteCronJob as deleteCronJobRequest,
  getBootstrap,
  getSession,
  getVersion,
  listWorkspaceCronJobs,
  listWorkspaceSessions,
  listWorkspaces as listWorkspacesRequest,
  logout as logoutRequest,
  openSession,
  sendPrompt,
  setSessionModel,
  setSessionThinkingLevel,
  updateCronJob as updateCronJobRequest,
} from "@/client/lib/api";
import {
  readCachedBootstrap,
  readCachedSession,
  writeCachedBootstrap,
  writeCachedSession,
} from "@/client/lib/cache";
import { primeAgentNotifications } from "@/client/lib/agent-notifications";
import { syncPushSubscription } from "@/client/lib/push-notifications";
import { applyServerEvent } from "@/client/lib/session-events";
import { mergeSessionState, normalizeSessionState } from "@/client/lib/session-state";
import { sessionEventsPath } from "@/client/lib/session-stream";
import { mergeSessionSummaries, toSessionSummary } from "@/client/lib/session-summary";
import { workspaceEventsPath } from "@/client/lib/workspace-stream";
import { uniqueWorkspaces } from "@/client/lib/workspaces";
import type {
  AuthStatus,
  BootstrapPayload,
  CronJob,
  ModelOption,
  ServerEvent,
  SessionState,
  SessionSummary,
  UpdateCronJobInput,
  WorkspaceInfo,
  WorkspaceSnapshot,
} from "@/shared/types";

let eventSource: EventSource | undefined;
let workspaceEventSource: EventSource | undefined;

const defaultAuthStatus: AuthStatus = {
  passkeyCount: 0,
  passkeyLoginAvailable: false,
  registrationOpen: false,
  setupRequired: false,
};

function compareCronJobsByNextRun(left: CronJob, right: CronJob): number {
  if (left.state.nextRunAtMs == null && right.state.nextRunAtMs == null) {
    return left.createdAt - right.createdAt;
  }
  if (left.state.nextRunAtMs == null) {
    return 1;
  }
  if (right.state.nextRunAtMs == null) {
    return -1;
  }
  return left.state.nextRunAtMs - right.state.nextRunAtMs;
}

export const useAppStore = defineStore("app", {
  state: () => ({
    authenticated: false,
    bootstrapped: false,
    buildId: undefined as string | undefined,
    auth: defaultAuthStatus as AuthStatus,
    connectionState: "online" as "online" | "offline" | "connecting",
    workspaces: [] as WorkspaceInfo[],
    models: [] as ModelOption[],
    sessionsByWorkspace: {} as Record<string, SessionSummary[]>,
    cronJobsByWorkspace: {} as Record<string, CronJob[]>,
    activeSession: undefined as SessionState | undefined,
    selectedWorkspaceId: undefined as string | undefined,
    authError: undefined as string | undefined,
    lastError: undefined as string | undefined,
    routeLoadingWorkspaceId: undefined as string | undefined,
    routeLoadingSessionId: undefined as string | undefined,
    loadingWorkspaceSessions: {} as Record<string, boolean>,
    loadingWorkspaceCronJobs: {} as Record<string, boolean>,
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
    workspaceCronJobs(state): CronJob[] {
      if (!state.selectedWorkspaceId) {
        return [];
      }

      return state.cronJobsByWorkspace[state.selectedWorkspaceId] ?? [];
    },
  },
  actions: {
    async bootstrap(): Promise<void> {
      this.connectionState = navigator.onLine ? "online" : "offline";
      try {
        const payload = await getBootstrap();
        this.applyBootstrap(payload);
        await writeCachedBootstrap(payload);
        if (payload.authenticated) {
          void syncPushSubscription(false);
        }
      } catch (error) {
        const cached = await readCachedBootstrap();
        if (cached) {
          this.connectionState = "offline";
          this.applyBootstrap(cached);
          this.closeWorkspaceStream();
          this.lastError = error instanceof Error ? error.message : String(error);
        } else {
          throw error;
        }
      } finally {
        this.bootstrapped = true;
      }
    },

    applyBootstrap(payload: BootstrapPayload): void {
      const workspaces = uniqueWorkspaces(payload.workspaces);

      this.authenticated = payload.authenticated;
      this.auth = payload.auth;
      this.buildId = payload.buildId;
      this.workspaces = workspaces;
      this.models = payload.models;
      this.selectedWorkspaceId =
        this.selectedWorkspaceId &&
        workspaces.some((workspace) => workspace.id === this.selectedWorkspaceId)
          ? this.selectedWorkspaceId
          : workspaces[0]?.id;
      if (payload.authenticated) {
        this.authError = undefined;
        if (this.selectedWorkspaceId && this.connectionState !== "offline") {
          this.openWorkspaceStream(this.selectedWorkspaceId);
        }
      } else {
        this.activeSession = undefined;
        this.sessionsByWorkspace = {};
        this.cronJobsByWorkspace = {};
        this.closeStream();
        this.closeWorkspaceStream();
      }
    },

    setAuthError(error: unknown): void {
      this.authError = error instanceof Error ? error.message : String(error);
    },

    async logout(): Promise<void> {
      await logoutRequest();
      this.closeStream();
      this.closeWorkspaceStream();
      this.authenticated = false;
      this.activeSession = undefined;
      this.sessionsByWorkspace = {};
      this.cronJobsByWorkspace = {};
    },

    closeStream(): void {
      eventSource?.close();
      eventSource = undefined;
    },

    closeWorkspaceStream(): void {
      workspaceEventSource?.close();
      workspaceEventSource = undefined;
    },

    async loadWorkspaceSessions(workspaceId: string): Promise<void> {
      this.loadingWorkspaceSessions = {
        ...this.loadingWorkspaceSessions,
        [workspaceId]: true,
      };

      try {
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
      } finally {
        this.loadingWorkspaceSessions = {
          ...this.loadingWorkspaceSessions,
          [workspaceId]: false,
        };
      }
    },

    async loadWorkspaceCronJobs(workspaceId: string): Promise<void> {
      this.loadingWorkspaceCronJobs = {
        ...this.loadingWorkspaceCronJobs,
        [workspaceId]: true,
      };

      try {
        const jobs = await listWorkspaceCronJobs(workspaceId);
        this.cronJobsByWorkspace = {
          ...this.cronJobsByWorkspace,
          [workspaceId]: jobs,
        };
      } finally {
        this.loadingWorkspaceCronJobs = {
          ...this.loadingWorkspaceCronJobs,
          [workspaceId]: false,
        };
      }
    },

    selectWorkspace(workspaceId: string): void {
      this.selectedWorkspaceId = workspaceId;
      if (this.connectionState === "offline") {
        this.closeWorkspaceStream();
      } else {
        this.openWorkspaceStream(workspaceId);
      }
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

    async createWorkspace(name: string): Promise<SessionState> {
      const workspace = await createWorkspaceRequest(name);
      this.workspaces = await listWorkspacesRequest();
      this.sessionsByWorkspace = {
        ...this.sessionsByWorkspace,
        [workspace.id]: [],
      };
      this.cronJobsByWorkspace = {
        ...this.cronJobsByWorkspace,
        [workspace.id]: [],
      };
      this.selectWorkspace(workspace.id);
      await this.loadWorkspaceCronJobs(workspace.id);
      return this.startSession(workspace.id);
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
        const openedSession = normalizeSessionState(await openSession(workspaceId, sessionPath));
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

    clearActiveSession(): void {
      this.closeStream();
      this.activeSession = undefined;
    },

    setRouteLoading(workspaceId?: string, sessionId?: string): void {
      this.routeLoadingWorkspaceId = workspaceId;
      this.routeLoadingSessionId = sessionId;
    },

    clearRouteLoading(): void {
      this.routeLoadingWorkspaceId = undefined;
      this.routeLoadingSessionId = undefined;
    },

    openStream(session: Pick<SessionState, "id" | "sessionId" | "workspaceId" | "path">): void {
      this.closeStream();
      this.connectionState = "connecting";
      eventSource = new EventSource(sessionEventsPath(session));
      eventSource.onopen = () => {
        this.connectionState = "online";
        void this.checkForClientUpdate();
      };
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

    openWorkspaceStream(workspaceId: string): void {
      if (!workspaceId) {
        this.closeWorkspaceStream();
        return;
      }

      this.closeWorkspaceStream();
      workspaceEventSource = new EventSource(workspaceEventsPath(workspaceId));
      workspaceEventSource.onopen = () => {
        void this.checkForClientUpdate();
      };
      workspaceEventSource.onmessage = (message) => {
        const snapshot = JSON.parse(message.data) as WorkspaceSnapshot;
        this.sessionsByWorkspace = {
          ...this.sessionsByWorkspace,
          [snapshot.workspaceId]: snapshot.sessions,
        };
        this.cronJobsByWorkspace = {
          ...this.cronJobsByWorkspace,
          [snapshot.workspaceId]: snapshot.cronJobs,
        };
      };
      workspaceEventSource.onerror = () => {
        if (!navigator.onLine) {
          this.closeWorkspaceStream();
        }
      };
    },

    async refreshActiveSession(): Promise<void> {
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

    async sendPrompt(text: string, files: File[]): Promise<void> {
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

    async steerPrompt(text: string, files: File[]): Promise<void> {
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

    async updateCronJob(jobId: string, patch: UpdateCronJobInput): Promise<CronJob> {
      const job = await updateCronJobRequest(jobId, patch);
      const workspaceJobs = this.cronJobsByWorkspace[job.workspaceId] ?? [];
      this.cronJobsByWorkspace = {
        ...this.cronJobsByWorkspace,
        [job.workspaceId]: [
          job,
          ...workspaceJobs.filter((candidate) => candidate.id !== job.id),
        ].sort(compareCronJobsByNextRun),
      };
      return job;
    },

    async deleteCronJob(jobId: string): Promise<CronJob> {
      const job = await deleteCronJobRequest(jobId);
      const workspaceJobs = this.cronJobsByWorkspace[job.workspaceId] ?? [];
      this.cronJobsByWorkspace = {
        ...this.cronJobsByWorkspace,
        [job.workspaceId]: workspaceJobs.filter((candidate) => candidate.id !== job.id),
      };
      return job;
    },

    async stopActiveSession(): Promise<void> {
      if (!this.activeSession) {
        return;
      }
      await abortSession(this.activeSession.id);
      await this.refreshActiveSession();
    },

    async checkForClientUpdate(): Promise<void> {
      if (!this.bootstrapped) {
        return;
      }

      const currentBuildId = this.buildId;
      const { buildId } = await getVersion();
      this.buildId = buildId;
      if (currentBuildId && currentBuildId !== buildId) {
        window.location.reload();
      }
    },

    markOffline(): void {
      this.connectionState = "offline";
    },

    markOnline(): void {
      this.connectionState = "online";
      if (this.selectedWorkspaceId) {
        this.openWorkspaceStream(this.selectedWorkspaceId);
      }
      if (this.activeSession) {
        this.openStream(this.activeSession);
      }
    },
  },
});
