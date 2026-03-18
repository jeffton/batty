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
  kind: "workspace" | "self";
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
  messages: UiMessage[];
  activeAssistant?: Extract<UiMessage, { role: "assistant" }>;
  activeTools: ActiveToolRun[];
  title?: string;
}

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  reasoning: boolean;
  supportsImages: boolean;
}

export interface BootstrapPayload {
  authenticated: boolean;
  authUsername: string;
  buildId: string;
  workspaces: WorkspaceInfo[];
  models: ModelOption[];
  activeSession?: SessionState;
}

export type ServerEvent =
  | { type: "state"; state: SessionState }
  | { type: "assistant"; assistant?: Extract<UiMessage, { role: "assistant" }> }
  | { type: "tools"; tools: ActiveToolRun[] }
  | { type: "status"; isStreaming: boolean; pendingMessageCount: number }
  | { type: "error"; message: string };
