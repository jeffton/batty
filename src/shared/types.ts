export type UiContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export interface ToolExecutionDetails {
  diff?: string;
  firstChangedLine?: number;
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

export interface CronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastDurationMs?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
  lastSessionId?: string;
}

export interface CronJob {
  id: string;
  workspaceId: string;
  prompt: string;
  model: string;
  thinkingLevel: string;
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
  schedule: CronJobScheduleInput;
}

export interface UpdateCronJobInput {
  workspaceId?: string;
  prompt?: string;
  model?: string;
  thinkingLevel?: string;
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

export interface BootstrapPayload {
  authenticated: boolean;
  auth: AuthStatus;
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
