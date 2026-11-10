import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import type { SubscriptionProviderId } from "@/shared/provider-auth";
import { withBaseUrl } from "./base-url";
import { closeRpcTransport, rpcCall, type RpcCallOptions } from "./rpc";
import type { OwnerInputs } from "@/shared/owner-api";
import type { AppAppearance } from "@/shared/appearance";
import type { RemoteSettings } from "@/shared/remotes";
import type {
  AppSettingsStatus,
  BrowserDescriptor,
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
  SessionMessagesPage,
  SessionResourcesResponse,
  SessionState,
  WorkspaceInfo,
} from "@/shared/types";
import type { WorkspaceFilesResponse, WorkspaceFileSearchEvent } from "@/shared/workspace-files";
import type { MemoryTreeOverview, MemoryTreeExpansion } from "@/shared/memory-tree";
import {
  authorizeErrorReporting,
  reportBrowserError,
  withFetchDiagnostics,
} from "./browser-errors";
import type { FetchOperation } from "@/shared/browser-errors";

const bannerOperations: Partial<Record<keyof OwnerInputs, FetchOperation>> = {
  "session.get": "main",
  "session.messages": "history",
  "push.key": "push-key",
  "push.save": "push-sync",
  "push.delete": "push-delete",
  "main.stop": "stop",
  "main.queue.remove": "queue-remove",
};

/** HTTP errors are restricted to cookie authentication/bootstrap requests. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function value<K extends keyof OwnerInputs, T = unknown>(
  operation: K,
  input: OwnerInputs[K],
  options?: RpcCallOptions,
): Promise<T> {
  const execute = async () => (await rpcCall<T>(operation, input, options)).value;
  const diagnostic = bannerOperations[operation];
  return diagnostic ? withFetchDiagnostics(diagnostic, execute) : execute();
}
function query<K extends keyof OwnerInputs, T = unknown>(
  operation: K,
  input: OwnerInputs[K],
  signal?: AbortSignal,
): Promise<T> {
  const deadline = AbortSignal.timeout(20_000);
  return value(operation, input, {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
}
async function authRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBaseUrl(path), { credentials: "include", ...init });
  if (!response.ok) {
    const body = (await response.json()) as { error: string };
    throw new HttpError(body.error, response.status);
  }
  return response.json() as Promise<T>;
}

export function getWorkspaces(): Promise<{ workspaces: WorkspaceInfo[] }> {
  return query("workspace.list", {});
}
export function getWorkspaceGit(workspaceId: string): Promise<{ branch: string | null }> {
  return query("workspace.git", { workspaceId });
}
export function getWorkspaceFiles(workspaceId: string, path = ""): Promise<WorkspaceFilesResponse> {
  return query("workspace.files", { workspaceId, path });
}
export function getWorkspaceFile(
  workspaceId: string,
  path: string,
): Promise<WorkspaceFilesResponse> {
  return query("workspace.file", { workspaceId, path });
}
export async function searchWorkspaceFiles(
  workspaceId: string,
  name: string,
  signal: AbortSignal,
  onMatches: (paths: string[]) => void,
): Promise<void> {
  const reply = await rpcCall("workspace.search", { workspaceId, name }, { signal });
  const reader = reply.events!.getReader();
  let complete = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const event = item.value as WorkspaceFileSearchEvent;
      if (event.kind === "match") onMatches([event.path]);
      else if (event.kind === "done") complete = true;
      else throw new Error(`Search incomplete: ${event.message}`);
    }
    if (!complete) throw new Error("File search ended before completion");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export function getRemoteSettings(): Promise<RemoteSettings> {
  return query("remotes.get", {});
}
export function issueRemoteGrant(): Promise<{ id: string; token: string }> {
  return value("remotes.token.generate", {});
}
export function revokeRemoteGrant(id: string): Promise<{ ok: true }> {
  return value("remotes.token.revoke", { id });
}
export function addRemoteConnection(input: { url: string; token: string }): Promise<{ ok: true }> {
  return value("remotes.connection.add", input);
}
export function removeRemoteConnection(id: string): Promise<{ ok: true }> {
  return value("remotes.connection.remove", { id });
}
export function openCloudBrowser(workspaceId: string): Promise<BrowserDescriptor> {
  return value("browser.open", { workspaceId });
}
export function getMemoryTree(): Promise<MemoryTreeOverview> {
  return query("memory.tree", {});
}
export function expandMemoryNode(id: number, count: number): Promise<MemoryTreeExpansion> {
  return query("memory.expand", { id, count });
}
export function setSitePublic(siteId: string, isPublic: boolean): Promise<SiteDescriptor> {
  return value("site.public", { siteId, public: isPublic });
}
export function getPushPublicKey(): Promise<{ publicKey: string }> {
  return query("push.key", {});
}
export function savePushSubscription(subscription: PushSubscriptionJSON): Promise<{ ok: true }> {
  return value("push.save", { subscription });
}
export function deletePushSubscription(endpoint: string): Promise<{ ok: true }> {
  return value("push.delete", { endpoint });
}
export function getBootstrap(): Promise<BootstrapPayload> {
  return withFetchDiagnostics("bootstrap", () =>
    authRequest<BootstrapPayload>("/api/bootstrap", { signal: AbortSignal.timeout(20_000) }),
  ).then((payload) => {
    authorizeErrorReporting(payload.authenticated);
    return payload;
  });
}
export function getModels(): Promise<ModelOption[]> {
  return query("models.list", {});
}
export function getProviderAuthStatus(): Promise<ProviderAuthStatus> {
  return query("provider.status", {});
}
export function getMcpSettings(): Promise<McpSettingsResponse> {
  return query("mcp.settings", {});
}
export function saveMcpServer(
  name: string,
  config: McpSettingsResponse["servers"][number]["config"],
): Promise<McpSettingsResponse> {
  return value("mcp.set", { name, config });
}
export function removeMcpServer(name: string): Promise<McpSettingsResponse> {
  return value("mcp.remove", { name });
}
export function getMcpStatus(): Promise<McpStatus> {
  return query("mcp.status", {});
}
export function reconnectMcpServer(name: string): Promise<McpStatus> {
  return value("mcp.reconnect", { name });
}
export function logoutMcpServer(name: string): Promise<McpStatus> {
  return value("mcp.logout", { name });
}
export function startMcpLogin(name: string): Promise<McpAuthAttempt> {
  return value("mcp.login", { name });
}
export function getMcpAuthAttempt(attemptId: string): Promise<McpAuthAttempt> {
  return query("mcp.attempt", { attemptId });
}
export function completeMcpAuthAttempt(
  attemptId: string,
  callbackUrl: string,
): Promise<McpAuthAttempt> {
  return value("mcp.complete", { attemptId, callbackUrl });
}
export function cancelMcpAuthAttempt(attemptId: string): Promise<McpAuthAttempt> {
  return value("mcp.cancel", { attemptId });
}
export function getProviderAuthAttemptStatus(
  attemptId: string,
): Promise<{ completed: boolean; error?: string }> {
  return query("provider.attempt", { attemptId });
}
export function startProviderAuth(
  providerId: SubscriptionProviderId,
): Promise<ProviderAuthStartResponse> {
  return value("provider.start", { providerId });
}
export function completeProviderAuth(
  attemptId: string,
  callbackUrl: string,
): Promise<ProviderAuthStatus> {
  return value("provider.complete", { attemptId, callbackUrl });
}
export function setProviderApiKey(
  providerId: "google" | "openrouter",
  apiKey: string,
): Promise<ProviderAuthStatus> {
  return value("provider.key", { providerId, apiKey });
}

export function beginPasskeyLogin(): Promise<{
  requestId: string;
  optionsJSON: PublicKeyCredentialRequestOptionsJSON;
}> {
  return authRequest("/api/auth/login/options", { method: "POST" });
}
export function finishPasskeyLogin(
  requestId: string,
  response: AuthenticationResponseJSON,
): Promise<{ ok: true }> {
  return authRequest<{ ok: true }>("/api/auth/login/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, response }),
  }).then((result) => {
    closeRpcTransport();
    return result;
  });
}
export function beginPasskeyRegistration(
  setupCode: string,
): Promise<{ requestId: string; optionsJSON: PublicKeyCredentialCreationOptionsJSON }> {
  return authRequest("/api/auth/register/options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ setupCode }),
  });
}
export function finishPasskeyRegistration(
  requestId: string,
  response: RegistrationResponseJSON,
): Promise<{ ok: true }> {
  return authRequest<{ ok: true }>("/api/auth/register/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, response }),
  }).then((result) => {
    closeRpcTransport();
    return result;
  });
}
export function logout(): Promise<{ ok: true }> {
  closeRpcTransport();
  authorizeErrorReporting(false);
  return withFetchDiagnostics("logout", () => authRequest("/api/logout", { method: "POST" }));
}

export function setAssistantWorkspace(workspaceId: string): Promise<WorkspaceInfo[]> {
  return value<"settings.assistant-workspace", { workspaces: WorkspaceInfo[] }>(
    "settings.assistant-workspace",
    {
      workspaceId,
    },
  ).then((reply) => reply.workspaces);
}
export function setPushTitle(title: string): Promise<AppSettingsStatus> {
  return value("settings.push-title", { title });
}
export function setMemoryLanguage(language: string): Promise<AppSettingsStatus> {
  return value("settings.memory-language", { language });
}
export function setMemoryModel(modelId: string): Promise<AppSettingsStatus> {
  return value("settings.memory-model", { modelId });
}
export function setDefaultModel(
  modelId: string,
  thinkingLevel: string,
): Promise<AppSettingsStatus> {
  return value("settings.default-model", { modelId, thinkingLevel });
}
export function setAppearance(appearance: AppAppearance): Promise<AppSettingsStatus> {
  return value("settings.appearance", appearance);
}
export function setBraveSearchApiKey(apiKey: string): Promise<AppSettingsStatus> {
  return value("settings.brave-search", { apiKey });
}
export function getSettingsCopyValue(
  kind: "provider" | "environment" | "brave-search",
  name: string,
): Promise<{ value: string }> {
  return value("settings.copy-value", { kind, name });
}
export function listEnvironmentVariables(): Promise<{ names: string[] }> {
  return query("environment.list", {});
}
export function setEnvironmentVariable(
  name: string,
  variableValue: string,
): Promise<{ names: string[] }> {
  return value("environment.set", { name, value: variableValue });
}
export function removeEnvironmentVariable(name: string): Promise<{ names: string[] }> {
  return value("environment.remove", { name });
}
export function getAssistantAgentsFile(workspaceId: string): Promise<{ content: string }> {
  return query("assistant-agents.get", { workspaceId });
}
export function setAssistantAgentsFile(
  workspaceId: string,
  content: string,
): Promise<{ content: string }> {
  return value("assistant-agents.set", { workspaceId, content });
}
export function getBattyAgentsFile(): Promise<{ content: string }> {
  return query("agents.get", {});
}
export function setBattyAgentsFile(content: string): Promise<{ content: string }> {
  return value("agents.set", { content });
}
export function updateCronDelivery(
  jobId: string,
  delivery: "direct" | "assistant",
): Promise<CronJob> {
  return value("cron.command", { action: "update", jobId, delivery });
}
export function stopCronRun(runId: string): Promise<{ ok: true }> {
  return value("cron.command", { action: "stop-running", runId });
}
export function listWorkspaceCronJobs(workspaceId: string): Promise<CronJob[]> {
  return query("workspace.cron.jobs", { workspaceId });
}
export function listRunningSubagents(sessionId: string): Promise<RunningSubagent[]> {
  return query("session.subagents", { sessionId });
}
export function listRunningCronRuns(): Promise<CronRunLog[]> {
  return query("cron.running", {});
}
export function listWorkspaceCronRunLogs(workspaceId: string): Promise<CronRunLog[]> {
  return query("workspace.cron.logs", { workspaceId });
}
export function getMemoryStatus(): Promise<{
  pending: number;
  totalLeaves: number;
  builtLeaves: number;
  error?: string;
}> {
  return query("memory.status", {});
}
export function getMain(after?: string): Promise<SessionState> {
  return query("session.get", { sessionId: "main", after });
}
export function getMainMessages(options: {
  before?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<SessionMessagesPage> {
  return query(
    "session.messages",
    { sessionId: "main", before: options.before, limit: options.limit },
    options.signal,
  );
}

export async function submitMainPrompt(
  kind: "prompt" | "steer",
  text: string,
  files: File[],
  clientMessageId: string,
): Promise<{ disposition: "started" | "queued"; submissionId: string; sessionId: string }> {
  const correlationId = crypto.randomUUID();
  try {
    return await value(
      "main.submit",
      {
        kind,
        text,
        clientMessageId,
        correlationId,
        files: files.map((file) => ({ name: file.name, type: file.type, size: file.size })),
      },
      files.length ? { body: new Blob(files).stream() } : undefined,
    );
  } catch (error) {
    reportBrowserError(error, "submit", { correlationId, hasFiles: files.length > 0 });
    throw error;
  }
}
export function stopMain(): Promise<{ ok: true }> {
  return value("main.stop", {});
}
export function removeMainQueuedPrompt(
  kind: "steer" | "followUp",
  index: number,
): Promise<SessionState> {
  return value("main.queue.remove", { kind, index });
}
export function stopSubagent(sessionId: string): Promise<{ ok: true }> {
  return value("session.stop", { sessionId });
}
export function getSession(sessionId: string): Promise<SessionState> {
  return query("session.get", { sessionId });
}
export function getSessionResources(sessionId: string): Promise<SessionResourcesResponse> {
  return query("session.resources", { sessionId });
}
export function getSessionMessages(
  session: Pick<SessionState, "id">,
  options: { before?: string; limit?: number } = {},
): Promise<SessionMessagesPage> {
  return query("session.messages", {
    sessionId: session.id,
    before: options.before,
    limit: options.limit === undefined ? undefined : Math.floor(options.limit),
  });
}
