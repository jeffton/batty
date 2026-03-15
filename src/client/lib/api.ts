import type { BootstrapPayload, SessionState, SessionSummary, WorkspaceInfo } from "@/shared/types";

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: "include",
    ...init,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error?: string;
    };
    throw new Error(body.error || response.statusText);
  }

  return (await response.json()) as T;
}

export function getBootstrap(): Promise<BootstrapPayload> {
  return request("/api/bootstrap");
}

export function getVersion(): Promise<{ buildId: string }> {
  return request("/api/version");
}

export function getPushPublicKey(): Promise<{ publicKey: string }> {
  return request("/api/push/public-key");
}

export function savePushSubscription(subscription: PushSubscriptionJSON): Promise<{ ok: true }> {
  return request("/api/push/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription }),
  });
}

export function deletePushSubscription(endpoint: string): Promise<{ ok: true }> {
  return request("/api/push/subscriptions/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

export function login(password: string): Promise<{ ok: true }> {
  return request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

export function logout(): Promise<{ ok: true }> {
  return request("/api/logout", {
    method: "POST",
  });
}

export function listWorkspaces(): Promise<WorkspaceInfo[]> {
  return request("/api/workspaces");
}

export function createWorkspace(name: string): Promise<WorkspaceInfo> {
  return request("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export function listWorkspaceSessions(workspaceId: string): Promise<SessionSummary[]> {
  return request(`/api/workspaces/${workspaceId}/sessions`);
}

export function createSession(workspaceId: string): Promise<SessionState> {
  return request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
}

export function openSession(workspaceId: string, sessionPath: string): Promise<SessionState> {
  return request("/api/sessions/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, sessionPath }),
  });
}

export function getSession(sessionId: string): Promise<SessionState> {
  return request(`/api/sessions/${sessionId}`);
}

export function setSessionModel(sessionId: string, modelId: string): Promise<SessionState> {
  return request(`/api/sessions/${sessionId}/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId }),
  });
}

export function setSessionThinkingLevel(
  sessionId: string,
  thinkingLevel: string,
): Promise<SessionState> {
  return request(`/api/sessions/${sessionId}/thinking`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thinkingLevel }),
  });
}

export async function sendPrompt(
  sessionId: string,
  text: string,
  files: File[],
  streamingBehavior?: "steer" | "followUp",
): Promise<void> {
  const formData = new FormData();
  formData.set("text", text);
  if (streamingBehavior) {
    formData.set("streamingBehavior", streamingBehavior);
  }
  for (const file of files) {
    formData.append("files", file, file.name);
  }

  await request(`/api/sessions/${sessionId}/prompt`, {
    method: "POST",
    body: formData,
  });
}

export function abortSession(sessionId: string): Promise<{ ok: true }> {
  return request(`/api/sessions/${sessionId}/abort`, {
    method: "POST",
  });
}
