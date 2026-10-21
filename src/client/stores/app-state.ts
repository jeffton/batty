import type {
  AppSettingsStatus,
  AuthStatus,
  ProviderAuthStatus,
  ProviderAuthAttemptStatus,
  ProviderUsageUpdate,
  McpAuthAttempt,
  SessionState,
  ModelOption,
  WorkspaceInfo,
} from "@/shared/types";
import { DEFAULT_APP_COLOR, DEFAULT_APP_TITLE } from "@/shared/appearance";
export type ConnectionState = "online" | "offline" | "connecting";
export type AppActionContext = ReturnType<typeof createAppState> & Record<string, any>;
export function createAppState() {
  return {
    orchestrationVersion: 0,
    cronVersion: 0,
    authenticated: false,
    bootstrapped: false,
    bootstrapFailed: false,
    auth: {
      passkeyCount: 0,
      passkeyLoginAvailable: false,
      registrationOpen: false,
      setupRequired: false,
    } as AuthStatus,
    providerAuth: { providers: [] } as ProviderAuthStatus,
    providerAuthAttempts: {} as Record<string, ProviderAuthAttemptStatus>,
    mcpAuthAttempts: {} as Record<string, McpAuthAttempt>,
    authAttemptsVersion: 0,
    providerUsage: undefined as ProviderUsageUpdate | undefined,
    serverBuildId: undefined as string | undefined,
    settings: {
      braveSearchConfigured: false,
      appearance: { title: DEFAULT_APP_TITLE, color: DEFAULT_APP_COLOR },
    } as AppSettingsStatus,
    models: [] as ModelOption[],
    workspaces: [] as WorkspaceInfo[],
    activeSession: undefined as SessionState | undefined,
    connectionState: "connecting" as ConnectionState,
    authError: undefined as string | undefined,
    lastError: undefined as string | undefined,
    loadingOlderMessages: false,
  };
}
