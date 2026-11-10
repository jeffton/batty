import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import type { SubscriptionProviderId } from "@/shared/provider-auth";
import { withBaseUrl } from "./base-url";
import { closeRpcTransport, rpcCall, type RpcCallOptions } from "./rpc";
import type { OwnerInputs, OwnerOutputs } from "@/shared/owner-api";
import { RpcError } from "@/shared/rpc";
import type { AppAppearance } from "@/shared/appearance";
import type { BootstrapPayload, McpSettingsResponse, SessionState } from "@/shared/types";
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

function value<K extends keyof OwnerInputs>(
  operation: K,
  input: OwnerInputs[K],
  options?: RpcCallOptions,
): Promise<OwnerOutputs[K]> {
  const execute = async () => (await rpcCall(operation, input, options)).value;
  const diagnostic = bannerOperations[operation];
  return diagnostic ? withFetchDiagnostics(diagnostic, execute) : execute();
}
function query<K extends keyof OwnerInputs>(
  operation: K,
  input: OwnerInputs[K],
  signal?: AbortSignal,
): Promise<OwnerOutputs[K]> {
  const deadline = AbortSignal.timeout(20_000);
  return value(operation, input, {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
}
async function authRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response | undefined;
  try {
    response = await fetch(withBaseUrl(path), { credentials: "include", ...init });
    const body = (await response.json()) as T & { error: string };
    if (!response.ok) throw new HttpError(body.error, response.status);
    return body;
  } catch (error) {
    // Preserve HTTP/auth status even if the error response body was interrupted.
    if (response && !response.ok && !(error instanceof HttpError))
      throw new HttpError(`HTTP ${response.status}`, response.status);
    // Both fetch and response-body reads reject with TypeError on transport loss.
    if (error instanceof TypeError) throw new RpcError("OFFLINE", error.message);
    throw error;
  }
}

export function getWorkspaces() {
  return query("workspace.list", {});
}
export function getWorkspaceGit(workspaceId: string) {
  return query("workspace.git", { workspaceId });
}
export function getWorkspaceFiles(workspaceId: string, path = "") {
  return query("workspace.files", { workspaceId, path });
}
export function getWorkspaceFile(workspaceId: string, path: string) {
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
      const event = item.value;
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

export function getRemoteSettings() {
  return query("remotes.get", {});
}
export function issueRemoteGrant() {
  return value("remotes.token.generate", {});
}
export function revokeRemoteGrant(id: string) {
  return value("remotes.token.revoke", { id });
}
export function addRemoteConnection(input: { url: string; token: string }) {
  return value("remotes.connection.add", input);
}
export function removeRemoteConnection(id: string) {
  return value("remotes.connection.remove", { id });
}
export function openCloudBrowser(workspaceId: string) {
  return value("browser.open", { workspaceId });
}
export function getMemoryTree() {
  return query("memory.tree", {});
}
export function expandMemoryNode(id: number, count: number) {
  return query("memory.expand", { id, count });
}
export function setSitePublic(siteId: string, isPublic: boolean) {
  return value("site.public", { siteId, public: isPublic });
}
export function getPushPublicKey() {
  return query("push.key", {});
}
export function savePushSubscription(subscription: PushSubscriptionJSON) {
  return value("push.save", { subscription });
}
export function deletePushSubscription(endpoint: string) {
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
export function getModels() {
  return query("models.list", {});
}
export function getProviderAuthStatus() {
  return query("provider.status", {});
}
export function getMcpSettings() {
  return query("mcp.settings", {});
}
export function saveMcpServer(
  name: string,
  config: McpSettingsResponse["servers"][number]["config"],
) {
  return value("mcp.set", { name, config });
}
export function removeMcpServer(name: string) {
  return value("mcp.remove", { name });
}
export function getMcpStatus() {
  return query("mcp.status", {});
}
export function reconnectMcpServer(name: string) {
  return value("mcp.reconnect", { name });
}
export function logoutMcpServer(name: string) {
  return value("mcp.logout", { name });
}
export function startMcpLogin(name: string) {
  return value("mcp.login", { name });
}
export function getMcpAuthAttempt(attemptId: string) {
  return query("mcp.attempt", { attemptId });
}
export function completeMcpAuthAttempt(attemptId: string, callbackUrl: string) {
  return value("mcp.complete", { attemptId, callbackUrl });
}
export function cancelMcpAuthAttempt(attemptId: string) {
  return value("mcp.cancel", { attemptId });
}
export function getProviderAuthAttemptStatus(attemptId: string) {
  return query("provider.attempt", { attemptId });
}
export function startProviderAuth(providerId: SubscriptionProviderId) {
  return value("provider.start", { providerId });
}
export function completeProviderAuth(attemptId: string, callbackUrl: string) {
  return value("provider.complete", { attemptId, callbackUrl });
}
export function setProviderApiKey(providerId: "google" | "openrouter", apiKey: string) {
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

export function setAssistantWorkspace(workspaceId: string) {
  return value("settings.assistant-workspace", {
    workspaceId,
  }).then((reply) => reply.workspaces);
}
export function setPushTitle(title: string) {
  return value("settings.push-title", { title });
}
export function setMemoryLanguage(language: string) {
  return value("settings.memory-language", { language });
}
export function setMemoryModel(modelId: string) {
  return value("settings.memory-model", { modelId });
}
export function setDefaultModel(modelId: string, thinkingLevel: string) {
  return value("settings.default-model", { modelId, thinkingLevel });
}
export function setAppearance(appearance: AppAppearance) {
  return value("settings.appearance", appearance);
}
export function setBraveSearchApiKey(apiKey: string) {
  return value("settings.brave-search", { apiKey });
}
export function getSettingsCopyValue(
  kind: "provider" | "environment" | "brave-search",
  name: string,
) {
  return value("settings.copy-value", { kind, name });
}
export function listEnvironmentVariables() {
  return query("environment.list", {});
}
export function setEnvironmentVariable(name: string, variableValue: string) {
  return value("environment.set", { name, value: variableValue });
}
export function removeEnvironmentVariable(name: string) {
  return value("environment.remove", { name });
}
export function getAssistantAgentsFile(workspaceId: string) {
  return query("assistant-agents.get", { workspaceId });
}
export function setAssistantAgentsFile(workspaceId: string, content: string) {
  return value("assistant-agents.set", { workspaceId, content });
}
export function getBattyAgentsFile() {
  return query("agents.get", {});
}
export function setBattyAgentsFile(content: string) {
  return value("agents.set", { content });
}
export function updateCronDelivery(jobId: string, delivery: "direct" | "assistant") {
  return value("cron.command", { action: "update", jobId, delivery });
}
export function stopCronRun(runId: string) {
  return value("cron.command", { action: "stop-running", runId });
}
export function listWorkspaceCronJobs(workspaceId: string) {
  return query("workspace.cron.jobs", { workspaceId });
}
export function listRunningSubagents(sessionId: string) {
  return query("session.subagents", { sessionId });
}
export function listRunningCronRuns() {
  return query("cron.running", {});
}
export function listWorkspaceCronRunLogs(workspaceId: string) {
  return query("workspace.cron.logs", { workspaceId });
}
export function getMemoryStatus() {
  return query("memory.status", {});
}
export function getMain(after?: string) {
  return query("session.get", { sessionId: "main", after });
}
export function getMainMessages(options: {
  before?: string;
  limit?: number;
  signal?: AbortSignal;
}) {
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
) {
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
export function stopMain() {
  return value("main.stop", {});
}
export function removeMainQueuedPrompt(kind: "steer" | "followUp", index: number) {
  return value("main.queue.remove", { kind, index });
}
export function stopSubagent(sessionId: string) {
  return value("session.stop", { sessionId });
}
export function getSession(sessionId: string) {
  return query("session.get", { sessionId });
}
export function getSessionResources(sessionId: string) {
  return query("session.resources", { sessionId });
}
export function getSessionMessages(
  session: Pick<SessionState, "id">,
  options: { before?: string; limit?: number } = {},
) {
  return query("session.messages", {
    sessionId: session.id,
    before: options.before,
    limit: options.limit === undefined ? undefined : Math.floor(options.limit),
  });
}
