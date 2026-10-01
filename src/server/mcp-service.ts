import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  noOpUIContext,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
  type McpServerConfig,
  type McpStatusSnapshot,
} from "@earendil-works/pi-coding-agent";
import type {
  McpAuthAttempt,
  McpSettingsResponse,
  McpWorkspaceStatus,
  WorkspaceInfo,
} from "@/shared/types";
import { type AppConfig, loadEnvironmentFile } from "./config";
import { battyAgentDir } from "./pi-paths";
import {
  battyMcpLogPath,
  createBattyMcpCredentials,
  loadBattyMcpConfig,
  readMcpSettings,
  removeMcpServer,
  writeMcpServer,
} from "./mcp-settings";

type Control = {
  session: AgentSession;
  status: McpStatusSnapshot;
  errors: string[];
  closed?: Promise<void>;
};
type Auth = {
  state: McpAuthAttempt;
  callbackUrl?: string;
  input?: (value: string | undefined) => void;
  task?: Promise<void>;
};

/** Batty web management around Pi's native MCP extension and OAuth commands. */
export class McpService {
  private readonly controls = new Set<Control>();
  private readonly attempts = new Map<string, Auth>();
  private readonly snapshots = new Map<
    string,
    { workspaceId: string; status: McpStatusSnapshot }
  >();
  private closing = false;

  constructor(
    private readonly config: AppConfig,
    private readonly modelRuntime: ModelRuntime,
    private readonly changed: (workspaceId?: string) => Promise<void>,
  ) {}

  observe(sessionId: string, workspaceId: string, status: McpStatusSnapshot): void {
    this.snapshots.delete(sessionId);
    this.snapshots.set(sessionId, { workspaceId, status: structuredClone(status) });
  }

  forget(sessionId: string): void {
    this.snapshots.delete(sessionId);
  }

  readSettings(workspace?: WorkspaceInfo): McpSettingsResponse {
    return readMcpSettings(this.config, workspace);
  }

  async setServer(
    workspace: WorkspaceInfo | undefined,
    name: string,
    server: McpServerConfig,
  ): Promise<McpSettingsResponse> {
    writeMcpServer(this.config, workspace, name, server);
    await this.changed(workspace?.id);
    return this.readSettings(workspace);
  }

  async removeServer(
    workspace: WorkspaceInfo | undefined,
    name: string,
  ): Promise<McpSettingsResponse> {
    if (!removeMcpServer(this.config, workspace, name))
      throw Object.assign(new Error("MCP server not found"), { statusCode: 404 });
    await this.changed(workspace?.id);
    return this.readSettings(workspace);
  }

  private async openControl(workspace: WorkspaceInfo, auth?: Auth): Promise<Control> {
    if (this.closing) throw new Error("MCP management is closed");
    await loadEnvironmentFile(this.config.battyDir);
    let status: McpStatusSnapshot = { servers: [], errors: [] };
    const errors: string[] = [];
    let control: Control | undefined;
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace.path,
      agentDir: battyAgentDir(this.config),
      settingsManager: SettingsManager.inMemory({}),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        { name: "codemode", builtin: true, factory: createCodemodeExtension({ models: false }) },
        { name: "tool-search", builtin: true, factory: createToolSearchExtension() },
        {
          name: "mcp",
          builtin: true,
          factory: createMcpExtension({
            loadConfig: () => loadBattyMcpConfig(this.config, workspace.path),
            credentials: createBattyMcpCredentials(this.config),
            logPath: battyMcpLogPath(this.config),
            onStatusChange: (value) => {
              status = structuredClone(value);
              if (control) control.status = status;
            },
            openUrl: (url) => {
              if (auth) auth.state.authorizationUrl = url;
            },
          }),
        },
      ],
      additionalExtensionPaths: ["builtin:codemode", "builtin:tool-search", "builtin:mcp"],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: workspace.path,
      agentDir: battyAgentDir(this.config),
      modelRuntime: this.modelRuntime,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({}),
      resourceLoader,
      noTools: "all",
    });
    control = { session, status, errors };
    this.controls.add(control);
    try {
      if (this.closing) throw new Error("MCP management is closed");
      await session.bindExtensions({
        mode: "rpc",
        onError: (error) => {
          throw new Error(error.error);
        },
        uiContext: {
          ...noOpUIContext,
          notify: (message, type) => {
            if (type === "error") errors.push(message);
          },
          input: async (title, _placeholder, options) => {
            if (!auth || auth.state.status !== "pending" || options?.signal?.aborted)
              return undefined;
            auth.state.prompt = title;
            if (auth.callbackUrl) return auth.callbackUrl;
            return new Promise<string | undefined>((resolve) => {
              const finish = (value: string | undefined) => {
                options?.signal?.removeEventListener("abort", cancelled);
                auth.input = undefined;
                resolve(value);
              };
              const cancelled = () => finish(undefined);
              auth.input = finish;
              options?.signal?.addEventListener("abort", cancelled, { once: true });
            });
          },
        },
      });
      return control;
    } catch (error) {
      await this.closeControl(control);
      throw error;
    }
  }

  private closeControl(control: Control): Promise<void> {
    return (control.closed ??= (async () => {
      await control.session.abort();
      await control.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      control.session.dispose();
      this.controls.delete(control);
    })());
  }

  private async command(workspace: WorkspaceInfo, text: string): Promise<McpWorkspaceStatus> {
    const control = await this.openControl(workspace);
    try {
      await control.session.prompt(text);
      if (control.errors.length) throw new Error(control.errors.join("\n"));
      return this.workspaceStatus(workspace, control.status);
    } finally {
      await this.closeControl(control);
    }
  }

  async getStatus(workspace: WorkspaceInfo): Promise<McpWorkspaceStatus> {
    const snapshot = [...this.snapshots.values()].findLast(
      (value) => value.workspaceId === workspace.id,
    );
    return snapshot
      ? this.workspaceStatus(workspace, snapshot.status)
      : this.command(workspace, "/mcp");
  }

  private workspaceStatus(workspace: WorkspaceInfo, status: McpStatusSnapshot): McpWorkspaceStatus {
    const configs = new Map(
      loadBattyMcpConfig(this.config, workspace.path).servers.map((entry) => [
        entry.name,
        entry.config,
      ]),
    );
    const credentials = createBattyMcpCredentials(this.config);
    const result = structuredClone(status);
    return {
      ...result,
      servers: result.servers.map((server) => {
        const config = configs.get(server.name);
        return {
          ...server,
          hasOAuthCredentials: !!(
            server.usesOAuth &&
            config &&
            "url" in config &&
            credentials.tokens(config.url)
          ),
        };
      }),
    };
  }

  private requireServer(workspace: WorkspaceInfo, name: string): void {
    if (
      !loadBattyMcpConfig(this.config, workspace.path).servers.some((entry) => entry.name === name)
    )
      throw Object.assign(new Error("MCP server not found"), { statusCode: 404 });
  }

  async reconnect(workspace: WorkspaceInfo, name: string): Promise<McpWorkspaceStatus> {
    this.requireServer(workspace, name);
    const status = await this.command(workspace, `/mcp reconnect ${name}`);
    await this.changed(workspace.id);
    return status;
  }

  async logout(workspace: WorkspaceInfo, name: string): Promise<McpWorkspaceStatus> {
    this.requireServer(workspace, name);
    const status = await this.command(workspace, `/mcp logout ${name}`);
    await this.changed();
    return status;
  }

  startAuth(workspace: WorkspaceInfo, name: string): McpAuthAttempt {
    this.requireServer(workspace, name);
    if (this.closing) throw new Error("MCP management is closed");
    if ([...this.attempts.values()].some((auth) => auth.state.status === "pending"))
      throw Object.assign(new Error("An MCP sign-in is already pending"), { statusCode: 409 });
    const auth: Auth = {
      state: {
        attemptId: randomUUID(),
        workspaceId: workspace.id,
        serverName: name,
        status: "pending",
      },
    };
    this.attempts.set(auth.state.attemptId, auth);
    auth.task = (async () => {
      let control: Control | undefined;
      try {
        control = await this.openControl(workspace, auth);
        if (auth.state.status !== "pending") return;
        await control.session.prompt(`/mcp login ${name}`);
        if (auth.state.status !== "pending") return;
        if (control.errors.length) throw new Error(control.errors.join("\n"));
        await this.changed();
        auth.state.status = "completed";
      } catch (error) {
        if (auth.state.status === "pending") {
          auth.state.status = "failed";
          auth.state.error = error instanceof Error ? error.message : String(error);
        }
      } finally {
        auth.input?.(undefined);
        if (control) await this.closeControl(control);
      }
    })();
    return this.getAuthAttempt(auth.state.attemptId);
  }

  private attempt(id: string): Auth {
    const auth = this.attempts.get(id);
    if (!auth) throw Object.assign(new Error("MCP sign-in not found"), { statusCode: 404 });
    return auth;
  }

  getAuthAttempt(id: string): McpAuthAttempt {
    return { ...this.attempt(id).state };
  }

  async completeAuth(id: string, callbackUrl: string): Promise<McpAuthAttempt> {
    const auth = this.attempt(id);
    if (auth.state.status !== "pending")
      throw Object.assign(new Error("MCP sign-in is not pending"), { statusCode: 409 });
    if (!auth.state.authorizationUrl)
      throw Object.assign(new Error("MCP sign-in is preparing"), { statusCode: 409 });
    auth.callbackUrl = callbackUrl;
    auth.input?.(callbackUrl);
    return this.getAuthAttempt(id);
  }

  async cancelAuth(id: string): Promise<McpAuthAttempt> {
    const auth = this.attempt(id);
    if (auth.state.status === "pending") {
      auth.state.status = "cancelled";
      auth.input?.(undefined);
    }
    return this.getAuthAttempt(id);
  }

  async dispose(): Promise<void> {
    this.closing = true;
    for (const auth of this.attempts.values()) await this.cancelAuth(auth.state.attemptId);
    await Promise.all([...this.controls].map((control) => this.closeControl(control)));
    await Promise.all([...this.attempts.values()].map((auth) => auth.task));
  }
}
