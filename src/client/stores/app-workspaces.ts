import {
  createWorkspace as createWorkspaceRequest,
  listWorkspaceCronJobs,
  listWorkspaceSessions,
  listWorkspaces as listWorkspacesRequest,
  setWorkspaceAssistant as setWorkspaceAssistantRequest,
  setWorkspacePinned as setWorkspacePinnedRequest,
  setWorkspaceUiSettings as setWorkspaceUiSettingsRequest,
} from "@/client/lib/api";
import { mergeSessionSummaries, toSessionSummary } from "@/client/lib/session-summary";
import { workspaceEventsPath } from "@/client/lib/workspace-stream";
import { sortWorkspacesByRecentSession, uniqueWorkspaces } from "@/client/lib/workspaces";
import type { SessionState, WorkspaceSnapshot } from "@/shared/types";
import { closeEventSource, type AppActionContext } from "./app-state";

let workspaceEventSource: EventSource | undefined;

export const workspaceActions = {
  sortWorkspaces(this: AppActionContext): void {
    this.workspaces = sortWorkspacesByRecentSession(uniqueWorkspaces(this.workspaces));
  },

  closeWorkspaceStream(): void {
    closeEventSource(workspaceEventSource);
    workspaceEventSource = undefined;
  },

  async loadWorkspaceSessions(this: AppActionContext, workspaceId: string): Promise<void> {
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
      this.sortWorkspaces();
    } finally {
      this.loadingWorkspaceSessions = {
        ...this.loadingWorkspaceSessions,
        [workspaceId]: false,
      };
    }
  },

  async loadWorkspaceCronJobs(this: AppActionContext, workspaceId: string): Promise<void> {
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

  selectWorkspace(this: AppActionContext, workspaceId: string): void {
    this.selectedWorkspaceId = workspaceId;
    if (this.connectionState === "offline") {
      this.closeWorkspaceStream();
    } else {
      this.openWorkspaceStream(workspaceId);
    }
  },

  async toggleWorkspacePin(this: AppActionContext, workspaceId: string): Promise<void> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) {
      return;
    }

    this.workspaces = sortWorkspacesByRecentSession(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId ? { ...candidate, isPinned: !candidate.isPinned } : candidate,
      ),
    );

    try {
      this.workspaces = uniqueWorkspaces(
        await setWorkspacePinnedRequest(workspaceId, !workspace.isPinned),
      );
      this.sortWorkspaces();
    } catch (error) {
      this.workspaces = sortWorkspacesByRecentSession(
        this.workspaces.map((candidate) =>
          candidate.id === workspaceId ? { ...candidate, isPinned: workspace.isPinned } : candidate,
        ),
      );
      throw error;
    }
  },

  async setWorkspaceAssistant(this: AppActionContext, workspaceId?: string): Promise<void> {
    const previousWorkspaces = this.workspaces;
    this.workspaces = this.workspaces.map((candidate) => ({
      ...candidate,
      isAssistant: candidate.id === workspaceId,
    }));

    try {
      this.workspaces = uniqueWorkspaces(await setWorkspaceAssistantRequest(workspaceId));
      this.sortWorkspaces();
    } catch (error) {
      this.workspaces = previousWorkspaces;
      throw error;
    }
  },

  async toggleWorkspaceAssistant(this: AppActionContext, workspaceId: string): Promise<void> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) {
      return;
    }

    if (workspace.isAssistant) {
      return;
    }

    await this.setWorkspaceAssistant(workspaceId);
  },

  async createWorkspace(
    this: AppActionContext,
    name: string,
    rootPath?: string,
  ): Promise<SessionState> {
    const workspace = await createWorkspaceRequest(name, rootPath);
    this.workspaces = uniqueWorkspaces(await listWorkspacesRequest());
    this.sessionsByWorkspace = {
      ...this.sessionsByWorkspace,
      [workspace.id]: [],
    };
    this.cronJobsByWorkspace = {
      ...this.cronJobsByWorkspace,
      [workspace.id]: [],
    };
    this.workspaceUiSettings = {
      ...this.workspaceUiSettings,
      [workspace.id]: { easyMode: false },
    };
    this.sortWorkspaces();
    this.selectWorkspace(workspace.id);
    await this.loadWorkspaceCronJobs(workspace.id);
    return this.startSession(workspace.id);
  },

  openWorkspaceStream(this: AppActionContext, workspaceId: string): void {
    if (!workspaceId) {
      this.closeWorkspaceStream();
      return;
    }

    this.closeWorkspaceStream();
    const source = new EventSource(workspaceEventsPath(workspaceId));
    workspaceEventSource = source;
    source.onopen = () => {
      if (workspaceEventSource !== source) {
        return;
      }

      void this.checkForClientUpdate();
    };
    source.onmessage = (message) => {
      if (workspaceEventSource !== source) {
        return;
      }

      const snapshot = JSON.parse(message.data) as WorkspaceSnapshot;
      this.sessionsByWorkspace = {
        ...this.sessionsByWorkspace,
        [snapshot.workspaceId]: snapshot.sessions,
      };
      this.cronJobsByWorkspace = {
        ...this.cronJobsByWorkspace,
        [snapshot.workspaceId]: snapshot.cronJobs,
      };
      this.workspaceUiSettings = {
        ...this.workspaceUiSettings,
        [snapshot.workspaceId]: snapshot.uiSettings,
      };
      this.sortWorkspaces();
    };
    source.onerror = () => {
      if (workspaceEventSource !== source) {
        return;
      }

      if (!navigator.onLine) {
        this.closeWorkspaceStream();
      }
    };
  },

  async setWorkspaceEasyMode(
    this: AppActionContext,
    workspaceId: string,
    easyMode: boolean,
  ): Promise<void> {
    this.workspaceUiSettings = {
      ...this.workspaceUiSettings,
      [workspaceId]: { easyMode },
    };
    try {
      const settings = await setWorkspaceUiSettingsRequest(workspaceId, { easyMode });
      this.workspaceUiSettings = {
        ...this.workspaceUiSettings,
        [workspaceId]: settings,
      };
    } catch (error) {
      this.workspaceUiSettings = {
        ...this.workspaceUiSettings,
        [workspaceId]: { easyMode: !easyMode },
      };
      throw error;
    }
  },
};
