import type { ModelOption, WorkspaceInfo } from "./types";

export interface RemoteDiscovery {
  workspaces: WorkspaceInfo[];
  models: ModelOption[];
  defaultModel?: string;
}

export interface RemoteGrant {
  id: string;
  label: string;
}

export interface RemoteConnectionStatus {
  state: "connected" | "connecting" | "disconnected" | "error";
  error?: string;
}

export interface RemoteConnection {
  id: string;
  label: string;
  /** Only outgoing peers have an address; reverse peers use their authenticated channel. */
  url?: string;
  instanceId?: string;
  grantId?: string;
  transport?: "reverse";
  reverseDial?: boolean;
  reverseGrantId?: string;
  status?: RemoteConnectionStatus;
}

export interface RemoteSettings {
  instanceId: string;
  grants: RemoteGrant[];
  connections: RemoteConnection[];
}
