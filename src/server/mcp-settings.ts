import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
  const file = battyMcpConfigPath(config, workspace);
  const loaded = workspace
    ? loadBattyMcpConfig(config, workspace.path)
    : loadMcpConfig({
        agentDir: battyAgentDir(config),
        cwd: config.battyDir,
        projectTrusted: false,
      });
  return {
    servers: loaded.servers
      .filter((entry) => entry.source === file || entry.override === file)
      .map(({ name, config: serverConfig }) => ({
        name,
        config: serverConfig,
        scope: workspace ? "workspace" : "global",
      })),
    errors: loaded.errors.filter((error) => error.startsWith(`${file}:`)),
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
  const file = battyMcpConfigPath(config, workspace);
  if (workspace) {
    const existing = loadBattyMcpConfig(config, workspace.path).servers.find(
      (entry) => entry.name === name && entry.override === file,
    );
    if (existing) {
      const overrideKeys = ["enabled", "exposure", "toolExposure"] as const;
      const definition = (value: McpServerConfig) => {
        const { enabled: _enabled, exposure: _exposure, toolExposure: _tools, ...rest } = value;
        return rest;
      };
      if (isDeepStrictEqual(definition(validated), definition(existing.config))) {
        const previous = JSON.parse(readFileSync(file, "utf8")).mcpServers[name];
        const override = Object.fromEntries(
          overrideKeys
            .filter(
              (key) => key in previous || !isDeepStrictEqual(validated[key], existing.config[key]),
            )
            .filter((key) => validated[key] !== undefined)
            .map((key) => [key, validated[key]]),
        );
        // Native overrides contain only these settings; validate the effective server above.
        addMcpServerConfig(file, name, override as unknown as McpServerConfig);
        return;
      }
    }
    if ("url" in validated && validated.auth)
      throw Object.assign(new Error("auth is only allowed in the global mcp.json"), {
        statusCode: 400,
      });
  }
  addMcpServerConfig(file, name, validated);
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
