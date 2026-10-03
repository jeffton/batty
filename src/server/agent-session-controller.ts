import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Model,
  TextContent,
} from "@earendil-works/pi-ai";
import type { ResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PromptDisposition, QueuedPrompt } from "@/shared/types";
import type { SessionResources } from "./session-resources";
import type { SessionStore } from "./session-store";
import type { AgentEvent, ConversationView, SubmissionRecord } from "@earendil-works/pi-durable";

/** Native committed semantics plus Batty's receipt-aware settled boundary. */
export type SessionControllerEvent = AgentEvent | { type: "agent_settled" };

export interface AgentSessionPromptOptions {
  images?: ImageContent[];
  clientMessageId?: string;
  streamingBehavior?: "steer" | "followUp";
}

export interface CustomSessionInput {
  customType: string;
  content: string | Array<TextContent | ImageContent>;
  display: boolean;
  details?: Record<string, unknown>;
}

export interface ActiveSessionTool {
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult?: { content: unknown[]; details?: unknown };
}

/** The application-facing session contract, independent of Pi's SDK agent loop. */
export interface AgentSessionController {
  readonly sessionManager: SessionStore;
  readonly resources: SessionResources;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly sessionName: string | undefined;
  readonly model: Model<Api>;
  readonly thinkingLevel: ThinkingLevel;
  readonly isStreaming: boolean;
  readonly isClosing: boolean;
  readonly isCompacting: boolean;
  readonly pendingMessageCount: number;
  readonly messages: AgentMessage[];
  readonly settingsManager: SettingsManager;
  readonly resourceLoader: ResourceLoader;
  readonly streamingMessage: AssistantMessage | undefined;
  readonly runningTools: ActiveSessionTool[];
  readonly view: ConversationView;
  regularToolNames: Set<string>;
  getAvailableThinkingLevels(): ThinkingLevel[];
  getActiveToolNames(): string[];
  persistActiveTools(): Promise<void>;
  setActiveToolsByName(names: string[]): Promise<void>;
  setModel(model: Model<Api>): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  subscribe(listener: (event: SessionControllerEvent) => void | Promise<void>): () => void;
  prompt(text: string, options?: AgentSessionPromptOptions): Promise<PromptDisposition>;
  getQueuedPrompts(): QueuedPrompt[];
  removeQueuedPrompt(submissionId: number): Promise<void>;
  reloadResources(): Promise<void>;
  refreshContext(): Promise<void>;
  requestTurnEnd(): void;
  /** Hold the settled notification until host-owned operation receipts are committed. */
  deferSettlement(): () => Promise<void>;
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
  abortCompaction(): void;
  compact(instructions?: string): Promise<void>;
  queueCustomSteeringMessage(message: CustomSessionInput): Promise<void>;
  /** Inspect one deterministic native custom-input admission attempt. */
  getCustomInputSubmission(
    message: CustomSessionInput & { details: { battyResultReplyId: string } },
    attempt?: number,
  ): Promise<SubmissionRecord | undefined>;
  sendCustomMessage(
    message: CustomSessionInput,
    options?: {
      triggerTurn?: boolean;
      steerWhenBusy?: boolean;
      onAccepted?: () => void;
    },
  ): Promise<void>;
  dispose(): Promise<void>;
}
