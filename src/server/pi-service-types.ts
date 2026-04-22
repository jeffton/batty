import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type {
  ActiveToolRun,
  ModelOption,
  ServerEvent,
  ToolExecutionDetails,
  WorkspaceInfo,
} from "@/shared/types";

export interface UploadedFile {
  filename: string;
  data: Buffer;
}

export interface SessionSubscriber {
  (event: ServerEvent): void;
}

export interface PiModel {
  id: string;
  name: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  input: string[];
  contextWindow?: number;
}

export interface WebSession {
  id: string;
  workspace: WorkspaceInfo;
  session: AgentSession;
  subscribers: Set<SessionSubscriber>;
  activeAssistant?: AgentSession["messages"][number] | undefined;
  activeTools: Map<string, ActiveToolRun>;
  openedAt: number;
  modelFallbackMessage?: string | undefined;
  ephemeral: boolean;
  autoRetryActive?: boolean;
  suppressNextAgentEndCompletion?: boolean;
}

export interface LiveSession {
  workspace: WorkspaceInfo;
  session: AgentSession;
}

export function modelKey(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

export function toModelOption(model: PiModel): ModelOption {
  return {
    id: modelKey(model),
    label: `${model.name} · ${model.provider}`,
    provider: model.provider,
    reasoning: Boolean(model.reasoning),
    supportsImages: model.input.includes("image"),
  };
}

export function sessionUpdatedAt(session: AgentSession, openedAt: number): number {
  const lastMessage = [...session.messages].reverse().find((message) => "timestamp" in message);
  return typeof lastMessage?.timestamp === "number" ? lastMessage.timestamp : openedAt;
}

export function normalizeToolDetails(details: unknown): ToolExecutionDetails | undefined {
  return details && typeof details === "object" ? (details as ToolExecutionDetails) : undefined;
}
