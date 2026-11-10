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
