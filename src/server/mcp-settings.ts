import path from "node:path";
import {
  addMcpServerConfig,
  FileAuthStorageBackend,
  loadMcpConfig,
  McpOAuthCredentialStore,
  removeMcpServerConfig,
  validateMcpServerConfig,
  type LoadedMcpConfig,
  type McpServerConfig,
} from "@earendil-works/pi-coding-agent";
import type { WorkspaceInfo } from "@/shared/types";
import type { AppConfig } from "./config";
import { battyAgentDir, workspaceBattyDir } from "./pi-paths";

type McpSettingsConfig = Pick<AppConfig, "battyDir">;

export interface McpSettings {
  servers: Array<{
    name: string;
    config: McpServerConfig;
    scope: "global" | "workspace";
  }>;
  errors: string[];
}

export function battyMcpConfigPath(config: McpSettingsConfig, workspace?: WorkspaceInfo): string {
  return path.join(
    workspace ? workspaceBattyDir(workspace.path) : battyAgentDir(config),
    "mcp.json",
  );
}

/** Reads only the selected editable scope, without inherited servers. */
export function readMcpSettings(config: McpSettingsConfig, workspace?: WorkspaceInfo): McpSettings {
  const loaded = loadMcpConfig({
    agentDir: battyAgentDir(config),
    cwd: workspace?.path ?? config.battyDir,
    projectTrusted: false,
    globalConfigPath: battyMcpConfigPath(config, workspace),
  });
  return {
    servers: loaded.servers.map(({ name, config: serverConfig }) => ({
      name,
      config: serverConfig,
      scope: workspace ? "workspace" : "global",
    })),
    errors: loaded.errors,
  };
}

export function writeMcpServer(
  config: McpSettingsConfig,
  workspace: WorkspaceInfo | undefined,
  name: string,
  serverConfig: McpServerConfig,
): void {
  const validated = validateMcpServerConfig(name, serverConfig);
  if (typeof validated === "string") throw Object.assign(new Error(validated), { statusCode: 400 });
  addMcpServerConfig(battyMcpConfigPath(config, workspace), name, validated);
}

export function removeMcpServer(
  config: McpSettingsConfig,
  workspace: WorkspaceInfo | undefined,
  name: string,
): boolean {
  return removeMcpServerConfig(battyMcpConfigPath(config, workspace), name);
}

export function loadBattyMcpConfig(
  config: McpSettingsConfig,
  workspacePath: string,
  projectTrusted = true,
): LoadedMcpConfig {
  return loadMcpConfig({
    agentDir: battyAgentDir(config),
    cwd: workspacePath,
    projectTrusted,
    projectConfigPath: path.join(workspaceBattyDir(workspacePath), "mcp.json"),
  });
}

export function battyMcpLogPath(config: McpSettingsConfig): string {
  return path.join(battyAgentDir(config), "mcp.log");
}

export function createBattyMcpCredentials(config: McpSettingsConfig): McpOAuthCredentialStore {
  const agentDir = battyAgentDir(config);
  return new McpOAuthCredentialStore(
    new FileAuthStorageBackend(path.join(agentDir, "mcp-auth.json")),
    agentDir,
  );
}
