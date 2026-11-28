import type { JsonValue } from "@earendil-works/chord/json";
import type { WorkerCommand } from "../server/orchestration-workers";
import type { WorkerFileMetadata } from "../server/worker-files";
import type { RemoteDiscovery } from "./remotes";
import type {
  SentFileDescriptor,
  ServerEvent,
  SessionState,
  UiAssistantMessage,
  UiMessage,
} from "./types";

export type NodeCommandInput = {
  requestId: string;
  command: Omit<WorkerCommand, "files" | "nodeId" | "action" | "artifactRefs" | "browserId"> & {
    action: Exclude<WorkerCommand["action"], "report" | "workspaces">;
  };
  files?: WorkerFileMetadata[];
  actor?: { kind: "agent" | "main"; sessionId: string };
};

export type NodeFile = Omit<SentFileDescriptor, "storedPath">;
export type NodePresentation = { sentFiles?: NodeFile[]; importErrors?: string[] };

export type NodeAssistantMessage = Omit<
  UiAssistantMessage,
  "sentFiles" | "sites" | "fileChanges" | "historicalPresentation"
> & { presentation?: NodePresentation };
export type NodeMessage = Exclude<UiMessage, UiAssistantMessage> | NodeAssistantMessage;

export type NodeSessionEvent =
  | Extract<ServerEvent, { type: "state" | "tools" | "error" }>
  | (Omit<Extract<ServerEvent, { type: "reset" }>, "state"> & {
      senderProjection?: true;
      state: Omit<SessionState, "messages" | "activeAssistant"> & {
        messages: NodeMessage[];
        activeAssistant?: NodeAssistantMessage;
      };
    })
  | (Omit<Extract<ServerEvent, { type: "assistant" }>, "assistant"> & {
      assistant?: NodeAssistantMessage;
    });

export type NodeWorkerSummary = {
  sessionId: string;
  parentId?: string;
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
    details?: { assignmentId: string };
    control?: JsonValue;
    isError?: boolean;
    presentation?: NodePresentation;
  };
  "node.assignment": { status: string; text?: string; presentation?: NodePresentation };
  "node.file": NodeFile;
  "node.catalog.watch": null;
  "node.session.watch": null;
}

export interface NodeEvents {
  "node.catalog.watch": { workers: NodeWorkerSummary[] };
  "node.session.watch": NodeSessionEvent;
}

export type NodeOperation = keyof NodeInputs;
export type NodeEvent<K extends NodeOperation> = K extends keyof NodeEvents ? NodeEvents[K] : never;
