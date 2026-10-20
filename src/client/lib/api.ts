import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { withBaseUrl } from "@/client/lib/base-url";
import type { AppAppearance } from "@/shared/appearance";
import type { RemoteSettings } from "@/shared/remotes";
import type {
  AppSettingsStatus,
  BootstrapPayload,
  CronJob,
  CronRunLog,
  RunningSubagent,
  SiteDescriptor,
  ModelOption,
  McpAuthAttempt,
  McpSettingsResponse,
  McpStatus,
  ProviderAuthStartResponse,
  ProviderAuthStatus,
  ProviderUsage,
  SessionMessagesPage,
  SessionResourcesResponse,
  SessionState,
  WorkspaceInfo,
} from "@/shared/types";

import type { MemoryTreeOverview, MemoryTreeExpansion } from "@/shared/memory-tree";
import {
  authorizeErrorReporting,
  reportBrowserError,
  withFetchDiagnostics,
} from "./browser-errors";
import type { FetchOperation } from "@/shared/browser-errors";

// Only requests used by handlers that can set the main composer error banner.
const bannerRequests: Record<string, FetchOperation> = {
  "/api/bootstrap": "bootstrap",
  "/api/workspaces": "workspaces",
  "/api/main": "main",
  "/api/main/messages": "history",
  "/api/push/public-key": "push-key",
  "/api/push/subscriptions": "push-sync",
  "/api/push/subscriptions/delete": "push-delete",
  "/api/logout": "logout",
  "/api/main/stop": "stop",
  "/api/main/queue/remove": "queue-remove",
};

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function getRemoteSettings(): Promise<RemoteSettings> {
  return request("/api/remotes");
}

function provisionRemote<T>(body: Record<string, string>): Promise<T> {
  return request("/api/remotes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function issueRemoteGrant(label: string): Promise<{ id: string; token: string }> {
  return provisionRemote({ action: "grant-add", label });
}

export function revokeRemoteGrant(id: string): Promise<{ ok: true }> {
  return provisionRemote({ action: "grant-revoke", id });
}

export function addRemoteConnection(input: {
  id: string;
  label: string;
  url: string;
  token: string;
}): Promise<{ ok: true }> {
  return provisionRemote({ ...input, action: "connection-add" });
}

export function removeRemoteConnection(id: string): Promise<{ ok: true }> {
  return provisionRemote({ action: "connection-remove", id });
}

export function getMemoryTree(): Promise<MemoryTreeOverview> {
  return request("/api/memory/tree");
}

export function expandMemoryNode(id: number, count: number): Promise<MemoryTreeExpansion> {
  return request(`/api/memory/tree/${id}/${count}`);
}

function request<T>(input: string, init?: RequestInit): Promise<T> {
  const operation = bannerRequests[input.split("?")[0]!];
  const execute = () => performRequest<T>(input, init);
  return operation ? withFetchDiagnostics(operation, execute) : execute();
}

async function performRequest<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBaseUrl(input), {
    credentials: "include",
    signal: !init?.method || init.method === "GET" ? AbortSignal.timeout(20_000) : undefined,
    ...init,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error?: string;
    };
    throw new HttpError(body.error || response.statusText, response.status);
  }

  return (await response.json()) as T;
}

export function setSitePublic(siteId: string, isPublic: boolean): Promise<SiteDescriptor> {
  return request(`/api/sites/${encodeURIComponent(siteId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ public: isPublic }),
  });
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

export function getBootstrap(): Promise<BootstrapPayload> {
  return request<BootstrapPayload>("/api/bootstrap").then((payload) => {
    authorizeErrorReporting(payload.authenticated);
    return payload;
  });
}

export function getModels(): Promise<ModelOption[]> {
  return request("/api/models");
}

export function getProviderUsage(provider: string, model: string): Promise<ProviderUsage> {
  const query = new URLSearchParams({ provider, model });
  return request(`/api/provider-usage?${query}`);
}

export function getProviderAuthStatus(): Promise<ProviderAuthStatus> {
  return request("/api/provider-auth/status");
}

export function getMcpSettings(): Promise<McpSettingsResponse> {
  return request("/api/settings/mcp");
}

export function saveMcpServer(
  name: string,
  config: McpSettingsResponse["servers"][number]["config"],
): Promise<McpSettingsResponse> {
  return request(`/api/settings/mcp/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
}

export function removeMcpServer(name: string): Promise<McpSettingsResponse> {
  return request(`/api/settings/mcp/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export function getMcpStatus(): Promise<McpStatus> {
  return request("/api/mcp");
}

export function reconnectMcpServer(name: string): Promise<McpStatus> {
  return request(`/api/mcp/${encodeURIComponent(name)}/reconnect`, { method: "POST" });
}

export function logoutMcpServer(name: string): Promise<McpStatus> {
  return request(`/api/mcp/${encodeURIComponent(name)}/logout`, { method: "POST" });
}

export function startMcpLogin(name: string): Promise<McpAuthAttempt> {
  return request(`/api/mcp/${encodeURIComponent(name)}/login`, { method: "POST" });
}

export function getMcpAuthAttempt(attemptId: string): Promise<McpAuthAttempt> {
  return request(`/api/mcp/auth/${encodeURIComponent(attemptId)}`);
}

export function completeMcpAuthAttempt(
  attemptId: string,
  callbackUrl: string,
): Promise<McpAuthAttempt> {
  return request(`/api/mcp/auth/${encodeURIComponent(attemptId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callbackUrl }),
  });
}

export function cancelMcpAuthAttempt(attemptId: string): Promise<McpAuthAttempt> {
  return request(`/api/mcp/auth/${encodeURIComponent(attemptId)}`, { method: "DELETE" });
}

export function getOpenAIAuthAttemptStatus(attemptId: string): Promise<{ completed: boolean }> {
  return request(`/api/provider-auth/openai/attempt/${encodeURIComponent(attemptId)}`);
}

export function startOpenAIProviderAuth(): Promise<ProviderAuthStartResponse> {
  return request("/api/provider-auth/openai/start", {
    method: "POST",
  });
}

export function completeOpenAIProviderAuth(
  attemptId: string,
  callbackUrl: string,
): Promise<ProviderAuthStatus> {
  return request("/api/provider-auth/openai/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attemptId, callbackUrl }),
  });
}

export function setProviderApiKey(
  providerId: "google" | "openrouter",
  apiKey: string,
): Promise<ProviderAuthStatus> {
  return request("/api/provider-auth/api-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId, apiKey }),
  });
}

export function beginPasskeyLogin(): Promise<{
  requestId: string;
  optionsJSON: PublicKeyCredentialRequestOptionsJSON;
}> {
  return request("/api/auth/login/options", {
    method: "POST",
  });
}

export function finishPasskeyLogin(
  requestId: string,
  response: AuthenticationResponseJSON,
): Promise<{ ok: true }> {
  return request("/api/auth/login/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, response }),
  });
}

export function beginPasskeyRegistration(setupCode: string): Promise<{
  requestId: string;
  optionsJSON: PublicKeyCredentialCreationOptionsJSON;
}> {
  return request("/api/auth/register/options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ setupCode }),
  });
}

export function finishPasskeyRegistration(
  requestId: string,
  response: RegistrationResponseJSON,
): Promise<{ ok: true }> {
  return request("/api/auth/register/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, response }),
  });
}

export function logout(): Promise<{ ok: true }> {
  authorizeErrorReporting(false);
  return request("/api/logout", {
    method: "POST",
  });
}

export function listWorkspaces(): Promise<WorkspaceInfo[]> {
  return request<{ workspaces: WorkspaceInfo[] }>("/api/workspaces").then(
    (response) => response.workspaces,
  );
}

export function setAssistantWorkspace(workspaceId: string): Promise<WorkspaceInfo[]> {
  return request<{ workspaces: WorkspaceInfo[] }>("/api/settings/assistant-workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  }).then((response) => response.workspaces);
}

export function setPushTitle(title: string): Promise<AppSettingsStatus> {
  return request("/api/settings/push-title", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export function setMemoryLanguage(language: string): Promise<AppSettingsStatus> {
  return request("/api/settings/memory-language", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language }),
  });
}

export function setMemoryModel(modelId: string): Promise<AppSettingsStatus> {
  return request("/api/settings/memory-model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId }),
  });
}

export function setDefaultModel(
  modelId: string,
  thinkingLevel: string,
): Promise<AppSettingsStatus> {
  return request("/api/settings/default-model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId, thinkingLevel }),
  });
}

export function setAppearance(appearance: AppAppearance): Promise<AppSettingsStatus> {
  return request("/api/settings/appearance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(appearance),
  });
}

export function setBraveSearchApiKey(apiKey: string): Promise<AppSettingsStatus> {
  return request("/api/settings/brave-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
}

export function listEnvironmentVariables(): Promise<{ names: string[] }> {
  return request("/api/settings/environment");
}

export function setEnvironmentVariable(name: string, value: string): Promise<{ names: string[] }> {
  return request(`/api/settings/environment/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

export function removeEnvironmentVariable(name: string): Promise<{ names: string[] }> {
  return request(`/api/settings/environment/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export function getAssistantAgentsFile(workspaceId: string): Promise<{ content: string }> {
  return request(`/api/settings/assistant-agents/${encodeURIComponent(workspaceId)}`);
}

export function setAssistantAgentsFile(
  workspaceId: string,
  content: string,
): Promise<{ content: string }> {
  return request(`/api/settings/assistant-agents/${encodeURIComponent(workspaceId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

export function getBattyAgentsFile(): Promise<{ content: string }> {
  return request("/api/settings/agents");
}

export function setBattyAgentsFile(content: string): Promise<{ content: string }> {
  return request("/api/settings/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

export function updateCronDelivery(
  jobId: string,
  delivery: "direct" | "assistant",
): Promise<CronJob> {
  return request("/api/cron", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update", jobId, delivery }),
  });
}

export function stopCronRun(runId: string): Promise<{ ok: true }> {
  return request("/api/cron", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "stop-running", runId }),
  });
}

export function listWorkspaceCronJobs(workspaceId: string): Promise<CronJob[]> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/cron-jobs`);
}

export function listRunningSubagents(sessionId: string): Promise<RunningSubagent[]> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/subagents`);
}

export function listWorkspaceCronRunLogs(workspaceId: string): Promise<CronRunLog[]> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/cron-run-logs`);
}

export function getMemoryStatus(): Promise<{
  pending: number;
  totalLeaves: number;
  builtLeaves: number;
  error?: string;
}> {
  return request("/api/memory/status");
}

export function getMain(after?: string): Promise<SessionState> {
  return request(`/api/main${after ? `?after=${encodeURIComponent(after)}` : ""}`);
}
export function getMainMessages(options: {
  before?: string;
  limit?: number;
}): Promise<SessionMessagesPage> {
  const query = new URLSearchParams();
  if (options.before) query.set("before", options.before);
  if (options.limit) query.set("limit", String(options.limit));
  return request(`/api/main/messages?${query}`);
}
export async function submitMainPrompt(
  kind: "prompt" | "steer",
  text: string,
  files: File[],
  clientMessageId: string,
): Promise<{ disposition: "started" | "queued"; submissionId: string; sessionId: string }> {
  const correlationId = crypto.randomUUID();
  try {
    const body = new FormData();
    body.set("text", text);
    body.set("clientMessageId", clientMessageId);
    for (const file of files) body.append("files", file, file.name);
    return await request(`/api/main/${kind}`, {
      method: "POST",
      body,
      headers: { "X-Batty-Correlation-ID": correlationId },
    });
  } catch (error) {
    reportBrowserError(error, "submit", {
      correlationId,
      status: error instanceof HttpError ? error.status : undefined,
      hasFiles: files.length > 0,
    });
    throw error;
  }
}
export function stopMain(): Promise<{ ok: true }> {
  return request("/api/main/stop", { method: "POST" });
}
export function removeMainQueuedPrompt(
  kind: "steer" | "followUp",
  index: number,
): Promise<SessionState> {
  return request("/api/main/queue/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, index }),
  });
}

export function stopSubagent(sessionId: string): Promise<{ ok: true }> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST" });
}

export function getSession(sessionId: string): Promise<SessionState> {
  return request(`/api/sessions/${sessionId}`);
}

export function getSessionResources(sessionId: string): Promise<SessionResourcesResponse> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/resources`);
}

export function getSessionMessages(
  session: Pick<SessionState, "id" | "workspaceId" | "path">,
  options: { before?: string; limit?: number } = {},
): Promise<SessionMessagesPage> {
  const params = new URLSearchParams();
  if (options.before) {
    params.set("before", options.before);
  }
  if (options.limit !== undefined) {
    params.set("limit", String(Math.floor(options.limit)));
  }

  return request(`/api/sessions/${session.id}/messages?${params.toString()}`);
}
