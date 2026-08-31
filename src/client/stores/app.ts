import { defineStore } from "pinia";
import { mergeSessionSummaries, toSessionSummary } from "@/client/lib/session-summary";
import type {
  CronJob,
  CronRunLog,
  RunningCronJob,
  SessionSummary,
  WorkspaceInfo,
} from "@/shared/types";
import { authBootstrapActions } from "./app-auth";
import { cronActions } from "./app-cron";
import { providerSettingsActions } from "./app-provider-settings";
import { createAppState, type AppStoreState } from "./app-state";
import { sessionActions } from "./app-sessions";
import { workspaceActions } from "./app-workspaces";

export const useAppStore = defineStore("app", {
  state: (): AppStoreState => createAppState(),
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
    workspaceRunningCronJobs(state): RunningCronJob[] {
      if (!state.selectedWorkspaceId) {
        return [];
      }

      return state.runningCronJobsByWorkspace[state.selectedWorkspaceId] ?? [];
    },
    workspaceCronRunLogs(state): CronRunLog[] {
      if (!state.selectedWorkspaceId) {
        return [];
      }

      return state.cronRunLogsByWorkspace[state.selectedWorkspaceId] ?? [];
    },
    workspaceEasyMode(state): boolean {
      return state.selectedWorkspaceId
        ? (state.workspaceUiSettings[state.selectedWorkspaceId]?.easyMode ?? false)
        : false;
    },
  },
  actions: {
    ...authBootstrapActions,
    ...workspaceActions,
    ...sessionActions,
    ...providerSettingsActions,
    ...cronActions,
  },
});
