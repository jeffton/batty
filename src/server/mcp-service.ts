import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir, type McpServerConfig } from "@earendil-works/pi-coding-agent";
import { toLlmContent } from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import type { AppConfig } from "./config";
import type { McpSettingsResponse, McpStatus } from "@/shared/types";
import { stateDirPath } from "./options";
import type { ToolRegistration } from "@earendil-works/pi-durable";

// Pi's public extension is tied to ExtensionAPI. These version-pinned lower-level
// modules implement the same transports, config validation, OAuth, and reconnects
// without creating a coding-agent session. Keep the boundary isolated here.
async function nativeModule(name: string): Promise<any> {
  return import(pathToFileURL(path.join(getPackageDir(), "dist", name)).href);
}

export class McpService {
  private session?: Promise<any[]>;
  private readonly structured = new WeakMap<object, unknown>();
  private readonly attempts = new Map<
    string,
    {
      state: any;
      controller: AbortController;
      input?: (url: string | undefined) => void;
      task?: Promise<void>;
    }
  >();
  private closing = false;
  private constructor(
    private readonly config: AppConfig,
    private readonly modules: any,
  ) {}

  static async create(config: AppConfig): Promise<McpService> {
    const [runtime, settings, auth, backend, core] = await Promise.all([
      nativeModule("extensions/mcp/runtime.js"),
      nativeModule("extensions/mcp/config.js"),
      nativeModule("extensions/mcp/oauth.js"),
      nativeModule("core/auth-storage.js"),
      nativeModule("core/mcp-servers.js"),
    ]);
    return new McpService(config, { runtime, settings, auth, backend, core });
  }

  // Shared stdio processes resolve relative commands and paths from Batty's
  // global data directory, never from a caller's workspace.
  private get runtimeCwd(): string {
    return this.config.battyDir;
  }

  private file(): string {
    return path.join(stateDirPath(this.config.battyDir), "mcp.json");
  }

  private loaded(): any {
    return this.modules.settings.loadMcpConfig({
      agentDir: stateDirPath(this.config.battyDir),
      cwd: this.runtimeCwd,
      projectTrusted: false,
    });
  }

  readSettings(): McpSettingsResponse {
    const loaded = this.loaded();
    return {
      servers: loaded.servers.map((entry: any) => ({
        name: entry.name,
        config: entry.config,
      })),
      errors: loaded.errors,
    };
  }

  async setServer(name: string, server: McpServerConfig): Promise<any> {
    const validated = this.modules.core.validateMcpServerConfig(name, server);
    if (typeof validated === "string")
      throw Object.assign(new Error(validated), { statusCode: 400 });
    this.modules.settings.addMcpServerConfig(this.file(), name, validated);
    await this.invalidate();
    return this.readSettings();
  }

  async removeServer(name: string): Promise<any> {
    if (!this.modules.settings.removeMcpServerConfig(this.file(), name))
      throw Object.assign(new Error("MCP server not found"), { statusCode: 404 });
    await this.invalidate();
    return this.readSettings();
  }

  private connections(): Promise<any[]> {
    if (this.closing) throw new Error("MCP service is closed");
    if (!this.session) {
      const pending = this.open();
      this.session = pending;
      pending.catch(() => {
        if (this.session === pending) this.session = undefined;
      });
    }
    return this.session;
  }

  private async open(): Promise<any[]> {
    const { runtime, auth, backend } = this.modules;
    const agentDir = stateDirPath(this.config.battyDir);
    const credentials = new auth.McpOAuthCredentialStore(
      new backend.FileAuthStorageBackend(path.join(agentDir, "mcp-auth.json")),
      agentDir,
    );
    const connections = this.loaded()
      .servers.filter((entry: any) => entry.config.enabled !== false)
      .map(
        (entry: any) =>
          new runtime.McpServerConnection({
            entry,
            cwd: this.runtimeCwd,
            credentials,
            createTransport: runtime.createDefaultTransport,
            onTools: () => {},
            log: new runtime.McpServerLog(path.join(agentDir, "mcp.log")),
          }),
      );
    await Promise.all(connections.map((connection: any) => connection.getClient().catch(() => {})));
    return connections;
  }

  async tools(): Promise<ToolRegistration[]> {
    return (await this.connections()).flatMap((connection: any) =>
      connection.tools
        .filter(
          (tool: any) =>
            this.modules.core.getMcpToolExposure(connection.entry.config, tool.name) !== "hidden",
        )
        .map((tool: any) => ({
          name: `mcp__${connection.name}__${tool.name}`.replace(/[^A-Za-z0-9_]/g, "_"),
          description: tool.description ?? tool.name,
          parameters: Type.Unsafe({
            ...tool.inputSchema,
            type: "object",
            properties: tool.inputSchema.properties ?? {},
          }),
          execute: async (args: any, _api: any, ctx: any) => {
            const result = await connection.callTool(tool.name, args, { signal: ctx.abortSignal });
            const wrapped = {
              content: toLlmContent(result),
              isError: result.isError === true,
              details: { server: connection.name, tool: tool.name },
            };
            this.rememberStructured(wrapped, result);
            return wrapped;
          },
        })),
    );
  }

  async catalog(): Promise<
    Array<{ tool: ToolRegistration; exposure: "direct" | "deferred" | "codemode" }>
  > {
    const tools = await this.tools();
    const exposures = new Map<string, "direct" | "deferred" | "codemode">();
    for (const connection of await this.connections())
      for (const tool of connection.tools) {
        const exposure = this.modules.core.getMcpToolExposure(connection.entry.config, tool.name);
        if (exposure !== "hidden")
          exposures.set(
            `mcp__${connection.name}__${tool.name}`.replace(/[^A-Za-z0-9_]/g, "_"),
            exposure,
          );
      }
    return tools.map((tool) => ({ tool, exposure: exposures.get(tool.name)! }));
  }

  rememberStructured(result: object, value: unknown): void {
    this.structured.set(result, value);
  }
  structuredResult(result: object): unknown {
    return this.structured.get(result);
  }

  async getStatus(): Promise<McpStatus> {
    const connections = await this.connections();
    const agentDir = stateDirPath(this.config.battyDir);
    const credentials = new this.modules.auth.McpOAuthCredentialStore(
      new this.modules.backend.FileAuthStorageBackend(path.join(agentDir, "mcp-auth.json")),
      agentDir,
    );
    const loaded = this.loaded();
    return {
      servers: loaded.servers.map((entry: any) => {
        const connection = connections.find((connection: any) => connection.name === entry.name);
        return {
          name: entry.name,
          state: connection?.state ?? "disabled",
          error: connection?.error,
          source: entry.source,
          tools: (connection?.tools ?? []).map((tool: any) => ({
            name: tool.name,
            description: tool.description,
            exposure: this.modules.core.getMcpToolExposure(entry.config, tool.name),
          })),
          usesOAuth: !!connection?.oauthUrl,
          hasOAuthCredentials: !!(
            connection?.oauthUrl && credentials.tokens(entry.name, connection.oauthUrl)
          ),
        };
      }),
      errors: loaded.errors,
    };
  }

  async reconnect(name: string): Promise<any> {
    const connection = (await this.connections()).find((value: any) => value.name === name);
    if (!connection) throw new Error(`Unknown MCP server: ${name}`);
    await connection.reconnect();
    return this.getStatus();
  }

  async logout(name: string): Promise<any> {
    const connection = (await this.connections()).find((value: any) => value.name === name);
    if (!connection) throw new Error(`Unknown MCP server: ${name}`);
    await connection.signOut();
    return this.getStatus();
  }

  startAuth(name: string): any {
    if (this.closing) throw new Error("MCP service is closed");
    if ([...this.attempts.values()].some((attempt) => attempt.state.status === "pending"))
      throw Object.assign(new Error("MCP sign-in already pending"), { statusCode: 409 });
    const attempt: {
      state: any;
      controller: AbortController;
      input?: (url: string | undefined) => void;
      task?: Promise<void>;
    } = {
      state: {
        attemptId: randomUUID(),
        serverName: name,
        status: "pending",
      },
      controller: new AbortController(),
    };
    this.attempts.set(attempt.state.attemptId, attempt);
    attempt.task = (async () => {
      try {
        const connection = (await this.connections()).find((value: any) => value.name === name);
        if (!connection?.oauthUrl) throw new Error(`MCP server does not use OAuth: ${name}`);
        if (attempt.state.status !== "pending") return;
        const agentDir = stateDirPath(this.config.battyDir);
        const credentials = new this.modules.auth.McpOAuthCredentialStore(
          new this.modules.backend.FileAuthStorageBackend(path.join(agentDir, "mcp-auth.json")),
          agentDir,
        );
        await this.modules.auth.signInMcpServer({
          serverUrl: connection.oauthUrl,
          store: credentials.forServer(name, connection.oauthUrl),
          settings: connection.oauthSettings(),
          challenge: connection.challenge,
          signal: attempt.controller.signal,
          prompt: {
            showAuthorizationUrl: (url: URL) => {
              attempt.state.authorizationUrl = url.href;
            },
            promptForRedirectUrl: (signal: AbortSignal) =>
              new Promise<string | undefined>((resolve) => {
                const finish = (value?: string) => {
                  signal.removeEventListener("abort", abort);
                  attempt.input = undefined;
                  resolve(value);
                };
                const abort = () => finish();
                attempt.input = finish;
                if (signal.aborted || attempt.state.status !== "pending") finish();
                else signal.addEventListener("abort", abort, { once: true });
              }),
          },
        });
        if (attempt.state.status === "pending") {
          await connection.reconnect();
          attempt.state.status = "completed";
        }
      } catch (error) {
        if (attempt.state.status === "pending") {
          attempt.state.status = "failed";
          attempt.state.error = String(error);
        }
      }
    })();
    return { ...attempt.state };
  }

  private attempt(id: string) {
    const attempt = this.attempts.get(id);
    if (!attempt) throw Object.assign(new Error("MCP sign-in not found"), { statusCode: 404 });
    return attempt;
  }
  getAuthAttempt(id: string): any {
    return { ...this.attempt(id).state };
  }
  async completeAuth(id: string, callbackUrl: string): Promise<any> {
    const attempt = this.attempt(id);
    if (attempt.state.status !== "pending" || !attempt.input)
      throw Object.assign(new Error("MCP sign-in is not awaiting a callback"), { statusCode: 409 });
    attempt.input(callbackUrl);
    return this.getAuthAttempt(id);
  }
  async cancelAuth(id: string): Promise<any> {
    const attempt = this.attempt(id);
    if (attempt.state.status === "pending") {
      attempt.state.status = "cancelled";
      attempt.controller.abort();
      attempt.input?.(undefined);
    }
    return this.getAuthAttempt(id);
  }

  private async invalidate(): Promise<void> {
    const pending = this.session ? [this.session] : [];
    this.session = undefined;
    await Promise.all(
      pending.map(async (value) =>
        Promise.all((await value).map((connection: any) => connection.close())),
      ),
    );
  }
  async dispose(): Promise<void> {
    this.closing = true;
    for (const id of this.attempts.keys()) await this.cancelAuth(id);
    await Promise.all([...this.attempts.values()].map((attempt) => attempt.task));
    await this.invalidate();
  }
}
