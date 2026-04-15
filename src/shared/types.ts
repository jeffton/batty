export type UiContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export interface SentFileDescriptor {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  kind: "file" | "image" | "video";
  downloadUrl: string;
  previewUrl?: string;
}

export interface ToolExecutionDetails {
  diff?: string;
  firstChangedLine?: number;
  sentFiles?: SentFileDescriptor[];
  [key: string]: unknown;
}

export type UiMessage =
  | {
      id: string;
      role: "user";
      timestamp: number;
      blocks: UiContentBlock[];
    }
  | {
      id: string;
      role: "assistant";
      timestamp: number;
      blocks: UiContentBlock[];
      model?: string;
      provider?: string;
      stopReason?: string;
      errorMessage?: string;
    }
  | {
      id: string;
      role: "toolResult";
      timestamp: number;
      toolCallId: string;
      toolName: string;
      blocks: UiContentBlock[];
      isError: boolean;
      details?: ToolExecutionDetails;
    }
  | {
      id: string;
      role: "bashExecution";
      timestamp: number;
      command: string;
      output: string;
      exitCode: number | null;
      cancelled: boolean;
      truncated: boolean;
      fullOutputPath?: string;
    }
  | {
      id: string;
      role: "custom";
      timestamp: number;
      customType: string;
      text: string;
    };

export interface ActiveToolRun {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  blocks: UiContentBlock[];
  status: "running" | "success" | "error";
  isError: boolean;
  details?: ToolExecutionDetails;
}

export interface WorkspaceInfo {
  id: string;
  label: string;
  path: string;
  kind: "workspace";
  isPinned: boolean;
}

export interface SessionSummary {
  id: string;
  sessionId: string;
  name?: string;
  path?: string;
  firstMessage: string;
  updatedAt: number;
  messageCount: number;
  workspaceId: string;
  model?: string;
  dailySession?: {
    date: string;
    isToday: boolean;
    exists: boolean;
  };
}

export type CronJobSchedule =
  | {
      kind: "at";
      at: string;
    }
  | {
      kind: "every";
      every: string;
    }
  | {
      kind: "cron";
      expression: string;
      timezone?: string;
    };

export type CronJobScheduleInput =
  | {
      kind: "at";
      at?: string;
      in?: string;
    }
  | {
      kind: "every";
      every: string;
    }
  | {
      kind: "cron";
      expression: string;
      timezone?: string;
    };

export type CronJobSession =
  | {
      kind: "new";
    }
  | {
      kind: "daily";
      includePreviousContext?: boolean;
    };

export interface CronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastDurationMs?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
  lastSessionId?: string;
  lastSessionPath?: string;
}

export interface CronJob {
  id: string;
  workspaceId: string;
  prompt: string;
  model: string;
  thinkingLevel: string;
  session: CronJobSession;
  createdAt: number;
  updatedAt: number;
  schedule: CronJobSchedule;
  scheduleLabel: string;
  state: CronJobState;
}

export interface CreateCronJobInput {
  workspaceId: string;
  prompt: string;
  model: string;
  thinkingLevel: string;
  session?: CronJobSession;
  schedule: CronJobScheduleInput;
}

export interface UpdateCronJobInput {
  workspaceId?: string;
  prompt?: string;
  model?: string;
  thinkingLevel?: string;
  session?: CronJobSession;
  schedule?: CronJobScheduleInput;
}

export interface SessionState {
  id: string;
  sessionId: string;
  workspaceId: string;
  cwd: string;
  path?: string;
  model?: string;
  modelLabel?: string;
  thinkingLevel: string;
  availableThinkingLevels: string[];
  isStreaming: boolean;
  pendingMessageCount: number;
  updatedAt: number;
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  totalMessageCount: number;
  hasMoreMessages: boolean;
  messages: UiMessage[];
  activeAssistant?: Extract<UiMessage, { role: "assistant" }>;
  activeTools: ActiveToolRun[];
  title?: string;
}

export type SessionStateMetadata = Omit<
  SessionState,
  "messages" | "activeAssistant" | "activeTools"
>;

export interface SessionMessagesPage {
  messages: UiMessage[];
  totalMessageCount: number;
  hasMoreMessages: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  reasoning: boolean;
  supportsImages: boolean;
}

export interface AuthStatus {
  passkeyCount: number;
  passkeyLoginAvailable: boolean;
  registrationOpen: boolean;
  setupRequired: boolean;
}

export interface ProviderAuthProviderStatus {
  id: string;
  name: string;
  connected: boolean;
  authKind?: "oauth" | "apiKey";
  connectedEmail?: string;
}

export interface ProviderAuthStatus {
  providers: ProviderAuthProviderStatus[];
}

export interface ProviderAuthStartResponse {
  attemptId: string;
  providerId: string;
  authUrl: string;
  instructions?: string;
  expiresAt: number;
}

export interface BootstrapPayload {
  authenticated: boolean;
  auth: AuthStatus;
  providerAuth: ProviderAuthStatus;
  buildId: string;
  workspaces: WorkspaceInfo[];
  models: ModelOption[];
  activeSession?: SessionState;
}

export interface WorkspaceSnapshot {
  workspaceId: string;
  sessions: SessionSummary[];
  cronJobs: CronJob[];
}

export type ServerEvent =
  | { type: "reset"; state: SessionState }
  | { type: "state"; state: SessionStateMetadata }
  | { type: "assistant"; assistant?: Extract<UiMessage, { role: "assistant" }> }
  | { type: "tools"; tools: ActiveToolRun[] }
  | { type: "status"; isStreaming: boolean; pendingMessageCount: number }
  | { type: "error"; message: string };
