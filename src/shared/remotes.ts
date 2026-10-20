export interface RemoteGrant {
  id: string;
  label: string;
}

export interface RemoteConnection {
  id: string;
  label: string;
  url: string;
  instanceId?: string;
  grantId?: string;
}

export interface RemoteSettings {
  instanceId: string;
  grants: RemoteGrant[];
  connections: RemoteConnection[];
}
