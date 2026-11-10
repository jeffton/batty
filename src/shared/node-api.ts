import type { JsonValue } from "@earendil-works/chord";
import type { WorkerCommand } from "../server/orchestration-workers";
import type { WorkerFileMetadata } from "../server/worker-files";
import type { AgentTurnArtifacts } from "../server/agent-turn-file-changes";
import type { RemoteDiscovery } from "./remotes";
import type { SentFileDescriptor, ServerEvent } from "./types";

export type NodeCommandInput = {
  requestId: string;
  command: Omit<WorkerCommand, "files" | "nodeId" | "action"> & {
    action: Exclude<WorkerCommand["action"], "report" | "workspaces">;
  };
  files?: WorkerFileMetadata[];
};

export type NodeWorkerSummary = {
  sessionId: string;
  workspaceId: string;
  status: string;
  startedAtMs?: number;
  terminalCursor?: string;
};

/** Authenticated peer operations; owner operations are a separate contract. */
export interface NodeInputs {
  "node.identity": Record<string, never>;
  "node.discovery": Record<string, never>;
  "node.unpair": Record<string, never>;
  "node.command": NodeCommandInput;
  "node.assignment": { assignmentId: string };
  "node.file": { workspaceId: string; sessionId: string; toolCallId: string; fileId: string };
  "node.catalog.watch": Record<string, never>;
  "node.session.watch": { sessionId: string; after?: string };
}

export interface NodeOutputs {
  "node.identity": { instanceId: string; name: string; grantId: string };
  "node.discovery": RemoteDiscovery;
  "node.unpair": { ok: true };
  "node.command": {
    output?: JsonValue;
    details?: JsonValue;
    control?: JsonValue;
    isError?: boolean;
  };
  "node.assignment": { status: string; text?: string; artifacts?: AgentTurnArtifacts };
  "node.file": SentFileDescriptor;
  "node.catalog.watch": null;
  "node.session.watch": null;
}

export interface NodeEvents {
  "node.catalog.watch": { workers: NodeWorkerSummary[] };
  "node.session.watch": ServerEvent;
}

export type NodeOperation = keyof NodeInputs;
export type NodeEvent<K extends NodeOperation> = K extends keyof NodeEvents ? NodeEvents[K] : never;
