import type { Context, JsonValue } from "@earendil-works/chord";

import { type Message, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  defineDoc,
  type Agent,
  type AgentChange,
  type AgentState,
  type Conversation,
  type ConversationId,
  type Harness,
  type ModelRef,
  type SubmissionId,
  type TaskId,
} from "@earendil-works/pi-durable";

import type { WorkspaceInfo } from "../shared/types.js";

import { type RuntimeNotice } from "./runtime-notices.js";

import type { AgentTurnArtifacts } from "./agent-turn-file-changes.js";

import { type WorkerRecord } from "./orchestration-history";

export type ContextMode = boolean | "chat-only";
export type ContextProvider = (
  parentId: ConversationId,
  mode: ContextMode,
) => Promise<readonly Message[]>;
export type PrepareAgent = (cwd: string, agent: Agent, context: Context) => Promise<AgentChange>;
export type InlineContext = {
  cwd: string | null;
  model: ModelRef | null;
  thinkingLevel: ModelThinkingLevel;
  runId: string;
  selection?: {
    extensions: NonNullable<AgentState["extensions"]> | null;
    tools: NonNullable<AgentState["tools"]> | null;
  };
};
export type ScheduleInput =
  | { kind: "at"; at?: string; in?: string }
  | { kind: "every"; every: string }
  | { kind: "cron"; expression: string; timezone?: string };
export type Schedule =
  | { kind: "at"; at: string }
  | { kind: "every"; every: string; everyMs: number }
  | { kind: "cron"; expression: string; timezone: string };
export type CronSession = {
  kind: "new" | "daily-inline" | "main-inline" | "daily-detached" | "main-detached";
  includePreviousContext?: ContextMode;
};
export type CronDelivery = "direct" | "assistant";
export type CronJobInput = {
  delivery?: CronDelivery;
  workspaceId?: string;
  enabled?: boolean;
  prompt: string;
  model?: string;
  thinkingLevel?: string;
  schedule: ScheduleInput;
  session?: CronSession;
};
export type CronJob = {
  delivery?: CronDelivery;
  id: string;
  workspaceId: string;
  enabled: boolean;
  prompt: string;
  model?: string;
  thinkingLevel?: string;
  schedule: Schedule;
  session: CronSession;
  nextAt?: number;
  retryAt?: number;
  createdAt: number;
  updatedAt: number;
};
type Worker = WorkerRecord;
export type CronRun = {
  id: string;
  jobId: string;
  workspaceId: string;
  scheduledAt: number;
  startedAt: number;
  taskId: TaskId<string>;
  sessionId: string;
  status: "running" | "completed" | "failed" | "aborted";
  finishedAt?: number;
  output?: string;
  job?: CronJob;
};

/** Session-wide worker registry; subagent results belong to their spawning parent. */
export const OrchestrationDoc = defineDoc<{
  mainId?: ConversationId;
  inlineContext?: InlineContext;
  workers: Record<string, Worker>;
  calls: Record<string, { workerId: string; taskId: TaskId<string> }>;
  joins?: Record<string, TaskId>;
  resultArtifacts?: Record<string, AgentTurnArtifacts & Record<string, JsonValue>>;
  joinParents?: Record<string, SubmissionId>;
  jobs: Record<string, CronJob>;
  runs: Record<string, CronRun>;
  archived?: boolean;
}>({
  kind: "batty.orchestration",
  version: 1,
  scope: "session",
  initial: () => ({ workers: {}, calls: {}, jobs: {}, runs: {} }),
  checkpointWhen: (_, __, info) => info.deltasSinceBase >= 31,
});

export const WorkerDoc = defineDoc<{
  workspaceId?: string;
  parentId?: ConversationId;
  isSubagent: boolean;
  isCron: boolean;
  cronJobId?: string;
  completion?: {
    owner: TaskId<string>;
    inputs: SubmissionId[];
    waits: Record<string, TaskId<null>>;
  };
}>({
  kind: "batty.worker",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ isSubagent: false, isCron: false }),
});

export interface OrchestrationConfig {
  config?: unknown;
  workspaces?:
    | readonly WorkspaceInfo[]
    | (() => readonly WorkspaceInfo[] | Promise<readonly WorkspaceInfo[]>);
  mainId?: ConversationId;
  /** Prepared provider context, not immutable storage history. Required for context copies. */
  contextFor?: ContextProvider;
  prepareAgent?: PrepareAgent;
  /** Used when the host's workspace list is managed by a service. */
  resolveWorkspace?: (
    id?: string,
    parentId?: ConversationId,
  ) => Promise<Pick<WorkspaceInfo, "id" | "path">>;
  onError?: (error: unknown) => void;
}

export type RunChange = {
  cwd?: string | null;
  model?: ModelRef | null;
  thinkingLevel?: ModelThinkingLevel | null;
};
export type DeliveryInput = {
  delivery?: CronDelivery;
  workerId: string;
  childId: ConversationId;
  mainId: ConversationId;
  prompt: string;
  notice?: RuntimeNotice;
  report: boolean;
  previous?: TaskId<string>;
  runId?: string;
  inline?: boolean;
  change?: RunChange;
  workspaceId?: string;
};
export interface WorkerBrowserLifecycle {
  admit<T>(id: string, operation: () => Promise<T>): Promise<T>;
  stop(id: string, taskId: string): Promise<void>;
}

export interface OrchestrationServices {
  readonly harness: Harness;
  readonly main: Conversation;
  readonly prepareAgent: PrepareAgent | undefined;
  readonly browserLifecycle: WorkerBrowserLifecycle | undefined;
  workspace(id?: string, parentId?: ConversationId): Promise<Pick<WorkspaceInfo, "id" | "path">>;
  assistantWorkspaceId(): Promise<string | undefined>;
  preparedContext(
    parentId: ConversationId,
    mode: ContextMode,
    workspaceId: string,
  ): Promise<readonly Message[]>;
}
