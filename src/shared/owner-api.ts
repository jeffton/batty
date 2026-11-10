import type * as Ui from "./types";
import type { RemoteSettings } from "./remotes";
import type { CloudBrowserState, CloudBrowserCredentialTarget } from "./cloud-browser";
import type { MemoryTreeOverview, MemoryTreeExpansion } from "./memory-tree";
import type { WorkspaceFilesResponse, WorkspaceFileSearchEvent } from "./workspace-files";

/** Native owner operations. Inputs are domain values, never HTTP envelopes. */
export type OwnerSessionEvent =
  | import("./types").ServerEvent
  | { type: "heartbeat" }
  | { type: "push-client"; clientId: string }
  | { type: "push-foreground"; clientId: string; challengeId: string };

export interface OwnerInputs {
  "remotes.get": Record<string, never>;
  "remotes.token.generate": Record<string, never>;
  "remotes.token.revoke": { id: string };
  "remotes.connection.add": { url: string; token: string };
  "remotes.connection.remove": { id: string };
  "diagnostics.report": { report: import("./browser-errors").BrowserErrorReport };
  "session.get": { sessionId: string; after?: string };
  "session.messages": { sessionId: string; before?: string; limit?: number };
  "session.resources": { sessionId: string };
  "session.subagents": { sessionId: string };
  "session.stop": { sessionId: string };
  "session.watch": { sessionId: string; after?: string };
  "main.submit": {
    kind: "prompt" | "steer";
    text: string;
    clientMessageId: string;
    correlationId?: string;
    files: { name: string; type: string; size: number }[];
  };
  "main.stop": Record<string, never>;
  "main.queue.remove": { kind?: string; index: number };
  "workspace.list": Record<string, never>;
  "workspace.git": { workspaceId: string };
  "workspace.files": { workspaceId: string; path?: string };
  "workspace.file": { workspaceId: string; path: string };
  "workspace.search": { workspaceId: string; name: string };
  "models.list": Record<string, never>;
  "memory.tree": Record<string, never>;
  "memory.expand": { id: number; count: number };
  "memory.status": Record<string, never>;
  "memory.usage": Record<string, never>;
  "memory.repair": {
    generation: number;
    roots: { start: number; count: number }[];
    dryRun: boolean;
  };
  "cron.command": { action: string; jobId?: string; runId?: string; [key: string]: unknown };
  "cron.running": Record<string, never>;
  "workspace.cron.jobs": { workspaceId: string };
  "workspace.cron.logs": { workspaceId: string };
  "provider.status": Record<string, never>;
  "provider.usage": { provider: string; model: string };
  "provider.start": { providerId: string };
  "provider.attempt": { attemptId: string };
  "provider.complete": { attemptId: string; callbackUrl: string };
  "provider.key": { providerId: "google" | "openrouter"; apiKey: string };
  "provider.logout": { providerId: string };
  "settings.assistant-workspace": { workspaceId: string };
  "settings.brave-search": { apiKey: string };
  "settings.appearance": { title: string; color: import("./appearance").AppColor };
  "settings.default-model": { modelId: string; thinkingLevel: string };
  "settings.memory-language": { language: string };
  "settings.memory-model": { modelId: string };
  "settings.push-title": { title: string };
  "settings.copy-value": { kind: "provider" | "environment" | "brave-search"; name: string };
  "environment.list": Record<string, never>;
  "environment.set": { name: string; value: string };
  "environment.remove": { name: string };
  "agents.get": Record<string, never>;
  "agents.set": { content: string };
  "assistant-agents.get": { workspaceId: string };
  "assistant-agents.set": { workspaceId: string; content: string };
  "mcp.settings": Record<string, never>;
  "mcp.set": { name: string; config: import("./types").McpServerConfig };
  "mcp.remove": { name: string };
  "mcp.status": Record<string, never>;
  "mcp.reconnect": { name: string };
  "mcp.logout": { name: string };
  "mcp.login": { name: string };
  "mcp.attempt": { attemptId: string };
  "mcp.complete": { attemptId: string; callbackUrl: string };
  "mcp.cancel": { attemptId: string };
  "push.key": Record<string, never>;
  "push.save": { subscription: PushSubscriptionJSON };
  "push.delete": { endpoint: string };
  "push.ack": { clientId: string; challengeId: string };
  "site.public": { siteId: string; public: boolean };
  "site.call": { siteId: string; name: string; input: unknown };
  "browser.open": { workspaceId: string };
  "browser.state": { browserId: string };
  "browser.control": { browserId: string; control: import("./cloud-browser").CloudBrowserControl };
  "browser.credentials.prepare": { browserId: string };
  "browser.credentials.fill": {
    browserId: string;
    credentials: import("./cloud-browser").CloudBrowserCredentials;
  };
  "auth.status": Record<string, never>;
  "auth.setup-code": Record<string, never>;
}

/** Domain results, shared by owner registrations and browser calls. */
export interface OwnerOutputs {
  "remotes.get": RemoteSettings;
  "remotes.token.generate": { id: string; token: string };
  "remotes.token.revoke": { ok: true };
  "remotes.connection.add": { ok: true };
  "remotes.connection.remove": { ok: true };
  "diagnostics.report": Record<string, never>;
  "session.get": Ui.SessionState;
  "session.messages": Ui.SessionMessagesPage;
  "session.resources": Ui.SessionResourcesResponse;
  "session.subagents": Ui.RunningSubagent[];
  "session.stop": { ok: true };
  "session.watch": Record<string, never>;
  "main.submit": { disposition: "started" | "queued"; submissionId: string; sessionId: string };
  "main.stop": { ok: true };
  "main.queue.remove": Ui.SessionState;
  "workspace.list": { workspaces: Ui.WorkspaceInfo[] };
  "workspace.git": { branch: string | null };
  "workspace.files": WorkspaceFilesResponse;
  "workspace.file": WorkspaceFilesResponse;
  "workspace.search": Record<string, never>;
  "models.list": Ui.ModelOption[];
  "memory.tree": MemoryTreeOverview;
  "memory.expand": MemoryTreeExpansion;
  "memory.status": {
    pending: number;
    totalLeaves: number;
    builtLeaves: number;
    settled: number;
    cacheBytes: number;
    cacheEntries: number;
    error?: string;
    rebuild?: {
      generation: number;
      total: number;
      completed: number;
      excluded: number;
      error?: string;
    };
  };
  "memory.usage": {
    incremental: MemoryUsageTotals;
    rebuild: MemoryUsageTotals;
    since: number | null;
    costBasis: string;
    coverage: string;
  };
  "memory.repair": { generation: number; nodes: { start: number; count: number; text?: string }[] };
  "cron.command": CronCommandResult;
  "cron.running": Ui.CronRunLog[];
  "workspace.cron.jobs": Ui.CronJob[];
  "workspace.cron.logs": Ui.CronRunLog[];
  "provider.status": Ui.ProviderAuthStatus;
  "provider.usage": Ui.ProviderUsage;
  "provider.start": Ui.ProviderAuthStartResponse;
  "provider.attempt": Ui.ProviderAuthAttemptStatus;
  "provider.complete": Ui.ProviderAuthStatus;
  "provider.key": Ui.ProviderAuthStatus;
  "provider.logout": Ui.ProviderAuthStatus;
  "settings.assistant-workspace": { workspaces: Ui.WorkspaceInfo[] };
  "settings.brave-search": Ui.AppSettingsStatus;
  "settings.appearance": Ui.AppSettingsStatus;
  "settings.default-model": Ui.AppSettingsStatus;
  "settings.memory-language": Ui.AppSettingsStatus;
  "settings.memory-model": Ui.AppSettingsStatus;
  "settings.push-title": Ui.AppSettingsStatus;
  "settings.copy-value": { value: string };
  "environment.list": { names: string[] };
  "environment.set": { names: string[] };
  "environment.remove": { names: string[] };
  "agents.get": { content: string };
  "agents.set": { content: string };
  "assistant-agents.get": { content: string };
  "assistant-agents.set": { content: string };
  "mcp.settings": Ui.McpSettingsResponse;
  "mcp.set": Ui.McpSettingsResponse;
  "mcp.remove": Ui.McpSettingsResponse;
  "mcp.status": Ui.McpStatus;
  "mcp.reconnect": Ui.McpStatus;
  "mcp.logout": Ui.McpStatus;
  "mcp.login": Ui.McpAuthAttempt;
  "mcp.attempt": Ui.McpAuthAttempt;
  "mcp.complete": Ui.McpAuthAttempt;
  "mcp.cancel": Ui.McpAuthAttempt;
  "push.key": { publicKey: string };
  "push.save": { ok: true };
  "push.delete": { ok: true };
  "push.ack": { ok: boolean };
  "site.public": Ui.SiteDescriptor;
  "site.call": unknown;
  "browser.open": Ui.BrowserDescriptor;
  "browser.state": CloudBrowserState;
  "browser.control": CloudBrowserState;
  "browser.credentials.prepare": CloudBrowserCredentialTarget;
  "browser.credentials.fill": Record<string, never>;
  "auth.status": Ui.AuthStatus;
  "auth.setup-code": { code: string; expiresAt: number };
}

export interface OwnerEvents {
  "session.watch": OwnerSessionEvent;
  "workspace.search": WorkspaceFileSearchEvent;
}

interface MemoryUsageTotals {
  attempts: number;
  measured: number;
  unmeasured: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  totalTokens: number;
  apiEquivalentCost: number;
}

/** Cron commands return persisted records rather than the enriched UI job view. */
export type StoredCronJob = Omit<
  Ui.CronJob,
  "model" | "thinkingLevel" | "scheduleLabel" | "state"
> & {
  model?: string;
  thinkingLevel?: string;
  nextAt?: number;
  retryAt?: number;
};
type StoredCronRun = {
  id: string;
  jobId: string;
  workspaceId: string;
  scheduledAt: number;
  startedAt: number;
  taskId: string | number;
  sessionId: string;
  status: "running" | "completed" | "failed" | "aborted";
  finishedAt?: number;
  output?: string;
  job?: StoredCronJob;
};
export type CronCommandResult =
  | StoredCronJob
  | Pick<
      StoredCronJob,
      "id" | "title" | "workspaceId" | "enabled" | "schedule" | "nextAt" | "retryAt"
    >[]
  | StoredCronRun[]
  | { ok: boolean }
  | undefined;
export type RemoteOwnerOperation = Extract<keyof OwnerInputs, `remotes.${string}`>;
