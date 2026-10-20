import type { McpExposure, McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { AppAppearance } from "./appearance";

export type UiContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      mimeType: string;
      data?: string;
      url?: string;
      previewUrl?: string;
      name?: string;
    }
  | { type: "attachment"; file: SentFileDescriptor }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export interface AgentTurnFileChange {
  path: string;
  patch: string;
}

export interface SentFileDescriptor {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  kind: "file" | "image" | "video";
  downloadUrl: string;
  previewUrl?: string;
  storedPath?: string;
}

export interface SiteDescriptor {
  kind: "site";
  id: string;
  name: string;
  url: string;
  public: boolean;
}

/** Forwarding preserves the live session and expiry, under Batty authentication. */
export interface BrowserDescriptor {
  kind: "browser";
  id: string;
  name: string;
  url: string;
  public: false;
  browserId: string;
}

export type SiteAttachmentDescriptor = SiteDescriptor | BrowserDescriptor;

export interface CodemodeCall {
  id: string;
  name: string;
  args: string;
  status: "running" | "ok" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
  cost?: number;
  subagent?: { sessionId?: string };
  details?: unknown;
  [key: string]: unknown;
}

export interface ToolExecutionDetails {
  calls?: CodemodeCall[];
  diff?: string;
  firstChangedLine?: number;
  sentFiles?: SentFileDescriptor[];
  sites?: SiteAttachmentDescriptor[];
  [key: string]: unknown;
}

export type UiAssistantTurnPhase = "pending" | "intermediate" | "final";

export interface UiAssistantMessage {
  id: string;
  role: "assistant";
  timestamp: number;
  turnPhase: UiAssistantTurnPhase;
  runTaskId?: string;
  blocks: UiContentBlock[];
  model?: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
  fileChanges?: AgentTurnFileChange[];
  sentFiles?: SentFileDescriptor[];
  sites?: SiteAttachmentDescriptor[];
}

export type UiMessage =
  | {
      id: string;
      role: "user";
      timestamp: number;
      clientMessageId?: string;
      blocks: UiContentBlock[];
    }
  | UiAssistantMessage
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
      data?: Record<string, unknown>;
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
  rootPath?: string;
  kind: "workspace";
  isPinned: boolean;
  isAssistant: boolean;
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
  lastAssistantReplyAt?: number;
  isInProgress?: boolean;
  hasUnread?: boolean;
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

export interface RunningSubagent {
  sessionId: string;
  sessionPath: string;
  workspaceId: string;
  parentSessionId: string;
  prompt: string;
  model: string;
  thinkingLevel: string;
  startedAtMs: number | null;
}

export interface RunningCronJob {
  runId: string;
  jobId: string;
  workspaceId: string;
  prompt: string;
  model: string;
  thinkingLevel: string;
  scheduleLabel: string;
  startedAtMs: number;
  sessionId?: string;
  sessionPath?: string;
}

export interface PendingCronRunDelivery {
  parentSessionId: string;
  queuedAtMs: number;
}

export interface CronRunLog extends RunningCronJob {
  status: "running" | "success" | "error";
  completedAtMs?: number;
  durationMs?: number;
  error?: string;
  pendingDelivery?: PendingCronRunDelivery;
}

export interface CronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastDurationMs?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
  lastSessionId?: string;
  lastSessionPath?: string;
}

export type CronDelivery = "direct" | "assistant";

export interface CronJob {
  title: string;
  delivery?: CronDelivery;
  id: string;
  workspaceId: string;
  enabled: boolean;
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
  title: string;
  delivery?: CronDelivery;
  workspaceId: string;
  enabled?: boolean;
  prompt: string;
  model: string;
  thinkingLevel: string;
  schedule: CronJobScheduleInput;
}

export interface UpdateCronJobInput {
  title?: string;
  delivery?: CronDelivery;
  workspaceId?: string;
  enabled?: boolean;
  prompt?: string;
  model?: string;
  thinkingLevel?: string;
  schedule?: CronJobScheduleInput;
}

export interface QueuedPrompt {
  kind: "steer" | "followUp";
  index: number;
  text: string;
  clientMessageId?: string;
  runtimeNoticeKind?: "cron" | "subagent";
}

export type PromptDisposition =
  | { disposition: "queued"; entryId: string }
  | { disposition: "completed" };

export type PromptSubmissionResult = PromptDisposition & { clientMessageId: string };

export interface SessionState {
  remote?: { nodeId: string; error?: string };
  id: string;
  revision?: number;
  streamId?: string;
  sessionId: string;
  workspaceId: string;
  cwd: string;
  path?: string;
  model?: string;
  modelLabel?: string;
  thinkingLevel: string;
  availableThinkingLevels: string[];
  isStreaming: boolean;
  isCompacting?: boolean;
  memoryPreparation?: { pending: number; totalLeaves: number; builtLeaves: number; error?: string };
  pendingMessageCount: number;
  queuedPrompts?: QueuedPrompt[];
  updatedAt: number;
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  totalMessageCount: number;
  hasMoreMessages: boolean;
  /** Entry cursor for bounded incremental archive catch-up, including invisible entries. */
  historyAfter?: string;
  historyCursor?: string;
  hasMoreRecentMessages?: boolean;
  messagesDetailLevel?: "summary" | "full";
  messages: UiMessage[];
  activeAssistant?: Extract<UiMessage, { role: "assistant" }>;
  activeTools: ActiveToolRun[];
  title?: string;
  isSubagentSession?: boolean;
  canStopSubagent?: boolean;
  isCronSession?: boolean;
}

export type SessionStateMetadata = Omit<
  SessionState,
  "messages" | "messagesDetailLevel" | "activeAssistant" | "activeTools"
>;

export interface SessionResourcesResponse {
  skills: Array<{ name: string; description: string; filePath: string }>;
  tools: Array<{ name: string; description: string }>;
}

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
  thinkingLevels: string[];
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

export interface ProviderUsageWindow {
  id: string;
  usedPercent: number;
  windowSeconds: number;
  resetsAt: number;
}

export interface ProviderUsage {
  windows: ProviderUsageWindow[];
}

export interface AppSettingsStatus {
  memoryModel: string;
  memoryLanguage: string;
  pushTitle: string;
  memoryReasoning: string;
  braveSearchConfigured: boolean;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  appearance: AppAppearance;
}

export interface WorkspaceUiSettings {
  easyMode: boolean;
}

export interface McpSettingsResponse {
  servers: Array<{
    name: string;
    config: McpServerConfig;
  }>;
  errors: string[];
}

export interface McpStatus {
  servers: Array<{
    name: string;
    state: string;
    usesOAuth: boolean;
    /** Stored OAuth tokens exist; connection state alone does not imply a sign-in. */
    hasOAuthCredentials: boolean;
    source?: string;
    tools: Array<{ name: string; description?: string; exposure: string }>;
    error?: string;
  }>;
  errors: string[];
}

export interface McpAuthAttempt {
  attemptId: string;
  serverName: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  authorizationUrl?: string;
  prompt?: string;
  error?: string;
}

export type { McpExposure, McpServerConfig };

export interface BootstrapPayload {
  authenticated: boolean;
  cacheScope?: string;
  cacheExpiresAt?: number;
  auth: AuthStatus;
  providerAuth: ProviderAuthStatus;
  settings: AppSettingsStatus;
  buildId: string;
  workspaceRoots: string[];
  workspaces: WorkspaceInfo[];
  workspaceUiSettings: Record<string, WorkspaceUiSettings>;
  models: ModelOption[];
  activeSession?: SessionState;
  workspaceSnapshots?: WorkspaceSnapshot[];
}

export interface WorkspaceSnapshot {
  workspaceId: string;
  streamId?: string;
  revision?: number;
  sessions: SessionSummary[];
  cronJobs: CronJob[];
  runningCronJobs: RunningCronJob[];
  cronRunLogs: CronRunLog[];
  uiSettings: WorkspaceUiSettings;
  isInProgress?: boolean;
  hasUnread?: boolean;
}

export type ServerEvent = (
  | { type: "reset"; state: SessionState }
  | { type: "state"; state: SessionStateMetadata }
  | { type: "assistant"; assistant?: Extract<UiMessage, { role: "assistant" }> }
  | {
      type: "assistant-delta";
      contentIndex: number;
      blockType: "text" | "thinking";
      delta: string;
    }
  | { type: "tools"; tools: ActiveToolRun[] }
  | {
      type: "tool-delta";
      toolCallId: string;
      deltas: Array<{
        contentIndex: number;
        blockType: "text" | "thinking";
        delta: string;
      }>;
      details?: ToolExecutionDetails;
    }
  | { type: "status"; isStreaming: boolean; pendingMessageCount: number }
  | { type: "error"; message: string }
) & { revision?: number; streamId?: string };
