import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { updateMcpServerConfig, type McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { WorkspaceInfo } from "@/shared/types";
import {
  battyMcpConfigPath,
  battyMcpLogPath,
  createBattyMcpCredentials,
  loadBattyMcpConfig,
  readMcpSettings,
  removeMcpServer,
  writeMcpServer,
} from "./mcp-settings";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-mcp-settings-"));
  roots.push(root);
  const config = { battyDir: root };
  const workspace: WorkspaceInfo = {
    id: "workspace",
    label: "Workspace",
    path: path.join(root, "workspace"),
    kind: "workspace",
    isPinned: false,
    isAssistant: false,
  };
  return { root, config, workspace };
}

async function put(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 4), { mode: 0o644 });
}

describe("native MCP settings", () => {
  it("reads each editable scope separately and merges trusted workspace overrides", async () => {
    const { config, workspace } = await setup();
    writeMcpServer(config, undefined, "shared", { command: "global" });
    writeMcpServer(config, undefined, "global", { url: "https://example.com/mcp" });
    writeMcpServer(config, workspace, "shared", { command: "workspace", enabled: false });
    expect(readMcpSettings(config).servers.map((server) => [server.name, server.scope])).toEqual([
      ["shared", "global"],
      ["global", "global"],
    ]);
    expect(readMcpSettings(config, workspace).servers).toEqual([
      { name: "shared", config: { command: "workspace", enabled: false }, scope: "workspace" },
    ]);
    const merged = loadBattyMcpConfig(config, workspace.path);
    expect(merged.servers[0]).toMatchObject({
      name: "shared",
      config: { command: "workspace", enabled: false },
      scope: "project",
      source: battyMcpConfigPath(config, workspace),
    });
    expect(loadBattyMcpConfig(config, workspace.path, false).servers[0]?.config).toEqual({
      command: "global",
    });
  });

  it("reads, edits and removes native project overrides without copying inherited fields", async () => {
    const { config, workspace } = await setup();
    writeMcpServer(config, undefined, "docs", {
      url: "https://example.com/mcp",
      auth: { provider: "radius" },
      exposure: "direct",
    });
    writeMcpServer(config, undefined, "unmodified", { command: "node" });
    const file = battyMcpConfigPath(config, workspace);
    await put(file, { mcpServers: { docs: { enabled: false } } });
    const settings = readMcpSettings(config, workspace);
    expect(settings.errors).toEqual([]);
    expect(settings.servers).toEqual([
      {
        name: "docs",
        scope: "workspace",
        config: {
          url: "https://example.com/mcp",
          auth: { provider: "radius" },
          exposure: "direct",
          enabled: false,
        },
      },
    ]);
    const server = settings.servers[0]!;
    writeMcpServer(config, workspace, server.name, { ...server.config, enabled: true });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      mcpServers: { docs: { enabled: true } },
    });
    writeMcpServer(config, workspace, server.name, {
      ...server.config,
      enabled: true,
      exposure: "codemode",
      toolExposure: { private: "hidden" },
    });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      mcpServers: {
        docs: { enabled: true, exposure: "codemode", toolExposure: { private: "hidden" } },
      },
    });
    expect(removeMcpServer(config, workspace, "docs")).toBe(true);
    expect(readMcpSettings(config, workspace).servers).toEqual([]);
    expect(loadBattyMcpConfig(config, workspace.path).servers[0]?.config).toEqual({
      url: "https://example.com/mcp",
      auth: { provider: "radius" },
      exposure: "direct",
    });
  });

  it("promotes edited override definitions and rejects workspace provider authentication", async () => {
    const { config, workspace } = await setup();
    writeMcpServer(config, undefined, "docs", { url: "https://example.com/mcp" });
    const file = battyMcpConfigPath(config, workspace);
    await put(file, { mcpServers: { docs: { enabled: false } } });
    writeMcpServer(config, workspace, "docs", {
      url: "https://workspace.example.com/mcp",
      enabled: false,
    });
    expect(loadBattyMcpConfig(config, workspace.path).servers[0]).toMatchObject({
      source: file,
      scope: "project",
      config: { url: "https://workspace.example.com/mcp", enabled: false },
    });
    expect(() =>
      writeMcpServer(config, workspace, "provider", {
        url: "https://example.com/mcp",
        auth: { provider: "radius" },
      }),
    ).toThrow("auth is only allowed in the global mcp.json");
    await put(file, {
      mcpServers: { provider: { url: "https://example.com/mcp", auth: { provider: "radius" } } },
    });
    expect(readMcpSettings(config, workspace).servers).toEqual([]);
    expect(readMcpSettings(config, workspace).errors[0]).toContain(
      "auth is only allowed in the global mcp.json",
    );
  });

  it("preserves native fields and indentation while replacing files privately and atomically", async () => {
    const { config } = await setup();
    const file = battyMcpConfigPath(config);
    await put(file, { autoEnableCodemode: false, custom: { keep: true }, mcpServers: {} });
    writeMcpServer(config, undefined, "docs", { url: "https://example.com/mcp" });
    updateMcpServerConfig(file, "docs", { enabled: false, exposure: "direct" });
    const content = await fs.readFile(file, "utf8");
    expect(content).toContain('\n    "autoEnableCodemode"');
    expect(JSON.parse(content)).toEqual({
      autoEnableCodemode: false,
      custom: { keep: true },
      mcpServers: { docs: { url: "https://example.com/mcp", enabled: false, exposure: "direct" } },
    });
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(path.dirname(file))).toEqual(["mcp.json"]);
    expect(removeMcpServer(config, undefined, "docs")).toBe(true);
    expect(removeMcpServer(config, undefined, "docs")).toBe(false);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({
      autoEnableCodemode: false,
      custom: { keep: true },
      mcpServers: {},
    });
  });

  it("rejects invalid edits before writing and reports native parse/validation errors", async () => {
    const { config, workspace } = await setup();
    expect(() => writeMcpServer(config, undefined, "bad.name", { command: "node" })).toThrow(
      "invalid server name",
    );
    expect(() =>
      writeMcpServer(config, undefined, "bad", {
        type: "sse",
        url: "https://example.com",
      } as unknown as McpServerConfig),
    ).toThrow("legacy SSE");
    await expect(fs.stat(battyMcpConfigPath(config))).rejects.toMatchObject({ code: "ENOENT" });
    await put(battyMcpConfigPath(config), {
      mcpServers: { invalid: { timeout: 0, command: "node" }, valid: { command: "node" } },
    });
    const result = readMcpSettings(config);
    expect(result.servers.map((server) => server.name)).toEqual(["valid"]);
    expect(result.errors[0]).toContain("positive number of seconds");
    await put(battyMcpConfigPath(config, workspace), []);
    expect(readMcpSettings(config, workspace).errors[0]).toContain('"mcpServers" object');
    const before = await fs.readFile(battyMcpConfigPath(config, workspace), "utf8");
    expect(() => writeMcpServer(config, workspace, "new", { command: "node" })).toThrow();
    expect(await fs.readFile(battyMcpConfigPath(config, workspace), "utf8")).toBe(before);
  });

  it("preserves native top-level discovery settings and ignores Pi project files", async () => {
    const { config, workspace } = await setup();
    await put(battyMcpConfigPath(config), { autoEnableCodemode: true });
    await put(battyMcpConfigPath(config, workspace), { autoEnableCodemode: false });
    await put(path.join(workspace.path, ".pi", "mcp.json"), {
      mcpServers: { ignored: { command: "node" } },
    });
    expect(loadBattyMcpConfig(config, workspace.path)).toEqual({
      servers: [],
      errors: [],
      autoEnableCodemode: false,
      projectConfig: path.join(workspace.path, ".batty", "mcp.json"),
    });
    expect(loadBattyMcpConfig(config, workspace.path, false).autoEnableCodemode).toBe(true);
  });

  it("stores native server-keyed OAuth credentials and logs under the Batty agent directory", async () => {
    const { root, config } = await setup();
    const credentials = createBattyMcpCredentials(config);
    const url = "https://example.com/mcp";
    const state = { serverUrl: url, tokens: { access_token: "test", token_type: "Bearer" } };
    await credentials.forServer("docs", url).save(state);
    expect(await createBattyMcpCredentials(config).forServer("docs", url).load()).toEqual(state);
    expect(credentials.tokens("docs", url)).toEqual(state.tokens);
    expect(battyMcpLogPath(config)).toBe(path.join(root, ".batty", "mcp.log"));
    const file = path.join(root, ".batty", "mcp-auth.json");
    expect(JSON.parse(await fs.readFile(file, "utf8"))[`mcp__docs|${url}`]).toEqual(state);
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(credentials.remove("docs", url)).toBe(true);
  });
});
