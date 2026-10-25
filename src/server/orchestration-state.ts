import type { Context, JsonValue } from "@earendil-works/chord";

import { type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  defineDoc,
  type Agent,
  type AgentChange,
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

export type PrepareAgent = (cwd: string, agent: Agent, context: Context) => Promise<AgentChange>;
export type SingleScheduleInput =
  | { kind: "at"; at?: string; in?: string }
  | { kind: "every"; every: string }
  | { kind: "cron"; expression: string; timezone?: string };
export type ScheduleInput =
  | SingleScheduleInput
  | { kind: "multiple"; triggers: SingleScheduleInput[] };
export type SingleSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; every: string; everyMs: number }
  | { kind: "cron"; expression: string; timezone: string };
export type Schedule =
  | SingleSchedule
  | { kind: "multiple"; triggers: (SingleSchedule & { nextAt?: number })[] };
export type CronDelivery = "direct" | "assistant";
export type CronJobInput = {
  title: string;
  delivery?: CronDelivery;
  workspaceId?: string;
  enabled?: boolean;
  prompt: string;
  model?: string;
  thinkingLevel?: string;
  schedule: ScheduleInput;
};
export type CronJob = {
  title: string;
  delivery?: CronDelivery;
  id: string;
  workspaceId: string;
  enabled: boolean;
  prompt: string;
  model?: string;
  thinkingLevel?: string;
  schedule: Schedule;
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
  latestResultAssignment?: TaskId<string>;
  latestReport?: {
    taskId: TaskId;
    assignmentId: TaskId<string>;
    text: string;
    artifacts: AgentTurnArtifacts & Record<string, JsonValue>;
  };
  completion?: {
    owner: TaskId<string>;
    inputs: SubmissionId[];
    waits: Record<string, TaskId<null>>;
  };
}>({
  kind: "batty.worker",
  checkpointWhen: () => false,
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
  remoteAssignment?: { grantId: string; requestId: string };
  workerId: string;
  childId: ConversationId;
  mainId: ConversationId;
  prompt: string;
  notice?: RuntimeNotice;
  report: boolean;
  previous?: TaskId<string>;
  runId?: string;
  change?: RunChange;
  workspaceId?: string;
};
export interface RemoteWorkerService {
  join(
    input: { node: string; session: string; assignmentId: string; parentId: ConversationId },
    signal: AbortSignal,
  ): Promise<void>;
  command(
    args: import("./orchestration-workers").WorkerCommand,
    api: import("./orchestration-workers").WorkerCommandContext,
    context: Context,
  ): Promise<import("@earendil-works/pi-durable").ToolExecutionResult>;
  list(): unknown[];
  workspaces(node?: string): Promise<unknown>;
}

export interface OrchestrationServices {
  readonly remoteWorkers?: RemoteWorkerService;
  readonly harness: Harness;
  readonly main: Conversation;
  readonly prepareAgent: PrepareAgent | undefined;
  workspace(id?: string, parentId?: ConversationId): Promise<Pick<WorkspaceInfo, "id" | "path">>;
  assistantWorkspaceId(): Promise<string | undefined>;
}
