import type {
  AppSettingsStatus,
  AuthStatus,
  CronJob,
  RunningCronJob,
  ModelOption,
  ProviderAuthStatus,
  SessionState,
  SessionSummary,
  WorkspaceInfo,
  WorkspaceUiSettings,
} from "@/shared/types";
import { DEFAULT_APP_COLOR, DEFAULT_APP_TITLE } from "@/shared/appearance";

export type ConnectionState = "online" | "offline" | "connecting";

export interface AppStoreState {
  authenticated: boolean;
  bootstrapped: boolean;
  buildId: string | undefined;
  auth: AuthStatus;
  providerAuth: ProviderAuthStatus;
  settings: AppSettingsStatus;
  connectionState: ConnectionState;
  workspaceConnectionState: ConnectionState;
  workspaceRoots: string[];
  workspaces: WorkspaceInfo[];
  models: ModelOption[];
  sessionsByWorkspace: Record<string, SessionSummary[]>;
  cronJobsByWorkspace: Record<string, CronJob[]>;
  runningCronJobsByWorkspace: Record<string, RunningCronJob[]>;
  workspaceUiSettings: Record<string, WorkspaceUiSettings>;
  activeSession: SessionState | undefined;
  selectedWorkspaceId: string | undefined;
  authError: string | undefined;
  lastError: string | undefined;
  routeLoadingWorkspaceId: string | undefined;
  routeLoadingSessionId: string | undefined;
  loadingWorkspaceSessions: Record<string, boolean>;
  loadingWorkspaceCronJobs: Record<string, boolean>;
  loadingOlderMessages: boolean;
}

export type AppActionContext = AppStoreState & Record<string, any>;

export const defaultAuthStatus: AuthStatus = {
  passkeyCount: 0,
  passkeyLoginAvailable: false,
  registrationOpen: false,
  setupRequired: false,
};

export const defaultProviderAuthStatus: ProviderAuthStatus = {
  providers: [],
};

export const defaultAppSettingsStatus: AppSettingsStatus = {
  braveSearchConfigured: false,
  appearance: {
    title: DEFAULT_APP_TITLE,
    color: DEFAULT_APP_COLOR,
  },
};

export function createAppState(): AppStoreState {
  return {
    authenticated: false,
    bootstrapped: false,
    buildId: undefined,
    auth: defaultAuthStatus,
    providerAuth: defaultProviderAuthStatus,
    settings: defaultAppSettingsStatus,
    connectionState: "online",
    workspaceConnectionState: "online",
    workspaceRoots: [],
    workspaces: [],
    models: [],
    sessionsByWorkspace: {},
    cronJobsByWorkspace: {},
    runningCronJobsByWorkspace: {},
    workspaceUiSettings: {},
    activeSession: undefined,
    selectedWorkspaceId: undefined,
    authError: undefined,
    lastError: undefined,
    routeLoadingWorkspaceId: undefined,
    routeLoadingSessionId: undefined,
    loadingWorkspaceSessions: {},
    loadingWorkspaceCronJobs: {},
    loadingOlderMessages: false,
  };
}

export function closeEventSource(source?: EventSource): void {
  if (!source) {
    return;
  }

  source.onopen = null;
  source.onmessage = null;
  source.onerror = null;
  source.close();
}
