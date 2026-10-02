// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ModelRuntime, type McpStatusSnapshot } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { McpAuthAttempt, WorkspaceInfo } from "@/shared/types";
import type { AppConfig } from "./config";
import { createBattyMcpCredentials } from "./mcp-settings";
import { McpService } from "./mcp-service";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-mcp-service-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const config = { battyDir: path.join(root, "data") } as AppConfig;
  const workspace: WorkspaceInfo = {
    id: "test",
    label: "Test",
    path: path.join(root, "workspace"),
    kind: "workspace",
    isPinned: false,
    isAssistant: false,
  };
  await fs.mkdir(workspace.path);
  // No registered provider, selected model, model credentials, or network model calls.
  const models = await ModelRuntime.create({
    modelsPath: null,
    authPath: path.join(root, "model-auth.json"),
    refreshOnCreate: false,
  });
  const changed = vi.fn(async (_workspaceId?: string) => {});
  const service = new McpService(config, models, changed);
  cleanups.push(() => service.dispose());
  return { root, config, workspace, service, changed };
}

async function waitForAttempt(
  service: McpService,
  id: string,
  predicate: (attempt: McpAuthAttempt) => boolean,
) {
  let attempt = service.getAuthAttempt(id);
  await vi.waitFor(
    () => {
      attempt = service.getAuthAttempt(id);
      expect(predicate(attempt), JSON.stringify(attempt)).toBe(true);
    },
    { timeout: 10_000, interval: 10 },
  );
  return attempt;
}

/** Entire MCP/OAuth fixture lives on loopback; only the native client makes HTTP requests. */
async function oauthServer() {
  let origin = "";
  let authorization: URL | undefined;
  const tokenRequests: URLSearchParams[] = [];
  const rpcMethods: string[] = [];
  const errors: string[] = [];
  const registrations: unknown[] = [];
  const server = http.createServer(async (request, response) => {
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url!, origin);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["tools"],
        });
      } else if (url.pathname === "/.well-known/oauth-authorization-server") {
        json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      } else if (url.pathname === "/register") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const metadata = JSON.parse(Buffer.concat(chunks).toString());
        registrations.push(metadata);
        json({ ...metadata, client_id: "loopback-client" }, 201);
      } else if (url.pathname === "/token") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = new URLSearchParams(Buffer.concat(chunks).toString());
        tokenRequests.push(body);
        const challenge = createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url");
        if (
          !authorization ||
          body.get("code") !== "test-code" ||
          body.get("grant_type") !== "authorization_code" ||
          body.get("client_id") !== "loopback-client" ||
          body.get("redirect_uri") !== authorization.searchParams.get("redirect_uri") ||
          challenge !== authorization.searchParams.get("code_challenge")
        ) {
          errors.push("Invalid authorization code or PKCE exchange");
          json({ error: "invalid_grant" }, 400);
          return;
        }
        json({
          access_token: "loopback-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "tools",
        });
      } else if (url.pathname === "/mcp") {
        if (request.headers.authorization !== "Bearer loopback-token") {
          response.setHeader(
            "WWW-Authenticate",
            `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="tools"`,
          );
          json({ error: "unauthorized" }, 401);
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405);
          response.end();
          return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const rpc = JSON.parse(Buffer.concat(chunks).toString());
        rpcMethods.push(rpc.method);
        if (rpc.id === undefined) {
          response.writeHead(202);
          response.end();
        } else if (rpc.method === "initialize") {
          json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              protocolVersion: rpc.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "loopback", version: "1" },
            },
          });
        } else if (rpc.method === "tools/list") {
          json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              tools: [
                {
                  name: "echo",
                  description: "Local echo",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          });
        } else {
          json({
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32601, message: "Method not found" },
          });
        }
      } else {
        json({ error: "not_found" }, 404);
      }
    } catch (error) {
      errors.push(String(error));
      json({ error: "fixture_failure" }, 500);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  origin = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return {
    url: `${origin}/mcp`,
    tokenRequests,
    registrations,
    rpcMethods,
    errors,
    callback(authorizationUrl: string, state?: string) {
      authorization = new URL(authorizationUrl);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "test-code");
      callback.searchParams.set("state", state ?? authorization.searchParams.get("state")!);
      return callback.href;
    },
  };
}

async function expectCallbackClosed(authorizationUrl: string) {
  const callback = new URL(authorizationUrl).searchParams.get("redirect_uri")!;
  await vi.waitFor(
    async () => {
      await expect(fetch(callback, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
    },
    { timeout: 5_000, interval: 20 },
  );
}

describe("native MCP web management", () => {
  it("edits scoped config and invalidates only the relevant workspace", async () => {
    const { service, workspace, changed } = await setup();
    await service.setServer(undefined, "shared", { command: "global", enabled: false });
    await service.setServer(workspace, "shared", { command: "workspace", enabled: false });
    expect(service.readSettings().servers).toEqual([
      { name: "shared", scope: "global", config: { command: "global", enabled: false } },
    ]);
    expect(service.readSettings(workspace).servers[0]).toMatchObject({
      scope: "workspace",
      config: { command: "workspace" },
    });
    expect(changed.mock.calls).toEqual([[undefined], [workspace.id]]);
    await service.removeServer(workspace, "shared");
    expect(service.readSettings(workspace).servers).toEqual([]);
    expect(service.readSettings().servers).toHaveLength(1);
    await expect(service.removeServer(workspace, "shared")).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(service.setServer(workspace, "bad.name", { command: "node" })).rejects.toThrow(
      "invalid server name",
    );
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("reads native status without model credentials and clones observed session snapshots", async () => {
    const { service, workspace } = await setup();
    expect(await service.getStatus(workspace)).toEqual({ servers: [], errors: [] });
    await service.setServer(workspace, "disabled", { command: "never-spawn", enabled: false });
    expect((await service.getStatus(workspace)).servers[0]).toMatchObject({
      name: "disabled",
      state: "disabled",
      usesOAuth: false,
      hasOAuthCredentials: false,
    });
    const snapshot: McpStatusSnapshot = { servers: [], errors: ["first"] };
    service.observe("one", workspace.id, snapshot);
    snapshot.errors.push("mutated");
    const first = await service.getStatus(workspace);
    first.errors.push("returned mutation");
    expect((await service.getStatus(workspace)).errors).toEqual(["first"]);
    service.observe("two", workspace.id, { servers: [], errors: ["latest"] });
    service.observe("other", "other-workspace", { servers: [], errors: ["unrelated"] });
    expect((await service.getStatus(workspace)).errors).toEqual(["latest"]);
    service.forget("two");
    expect((await service.getStatus(workspace)).errors).toEqual(["first"]);
    service.forget("one");
    expect((await service.getStatus(workspace)).servers[0]?.state).toBe("disabled");
    await expect(service.reconnect(workspace, "missing")).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(service.logout(workspace, "missing")).rejects.toMatchObject({ statusCode: 404 });
    expect(() => service.startAuth(workspace, "missing")).toThrow("MCP server not found");
    expect(() => service.getAuthAttempt("missing")).toThrow("MCP sign-in not found");
  });

  it("reads URL-keyed OAuth tokens independently of observed connection state", async () => {
    const { service, workspace, config } = await setup();
    const globalUrl = "https://global.example.test/mcp";
    const workspaceUrl = "https://workspace.example.test/mcp";
    await service.setServer(undefined, "docs", { url: globalUrl });
    await service.setServer(workspace, "docs", { url: workspaceUrl });
    await service.setServer(workspace, "public", { url: "https://public.example.test/mcp" });
    await service.setServer(workspace, "header", {
      url: "https://header.example.test/mcp",
      headers: { authorization: "Bearer configured" },
    });
    const credentials = createBattyMcpCredentials(config);
    await credentials.forServer("docs", globalUrl).save({
      serverUrl: globalUrl,
      tokens: { access_token: "global", token_type: "Bearer" },
    });
    const server = (name: string, usesOAuth: boolean): McpStatusSnapshot["servers"][number] => ({
      name,
      state: "connected",
      usesOAuth,
      source: path.join(workspace.path, ".batty", "mcp.json"),
      exposure: "codemode",
      tools: [],
    });
    const snapshot: McpStatusSnapshot = {
      servers: [server("docs", true), server("public", true), server("header", false)],
      errors: [],
    };
    service.observe("session", workspace.id, snapshot);
    expect(
      (await service.getStatus(workspace)).servers.map((entry) => entry.hasOAuthCredentials),
    ).toEqual([false, false, false]);
    await credentials.forServer("docs", workspaceUrl).save({
      serverUrl: workspaceUrl,
      tokens: { access_token: "workspace", token_type: "Bearer" },
    });
    await credentials.forServer("header", "https://header.example.test/mcp").save({
      serverUrl: "https://header.example.test/mcp",
      tokens: { access_token: "unused", token_type: "Bearer" },
    });
    snapshot.servers[0]!.state = "needs-auth";
    service.observe("session", workspace.id, snapshot);
    expect(
      (await service.getStatus(workspace)).servers.map((entry) => entry.hasOAuthCredentials),
    ).toEqual([true, false, false]);
    credentials.remove("docs", workspaceUrl);
    expect((await service.getStatus(workspace)).servers[0]).toMatchObject({
      state: "needs-auth",
      usesOAuth: true,
      hasOAuthCredentials: false,
    });
    expect(snapshot.servers[0]).not.toHaveProperty("hasOAuthCredentials");
  });

  it("runs native OAuth discovery, registration and PKCE, reconnects and logs out URL-keyed credentials", async () => {
    const { service, workspace, config, changed } = await setup();
    const issuer = await oauthServer();
    await service.setServer(workspace, "local", { url: issuer.url });
    expect((await service.getStatus(workspace)).servers[0]).toMatchObject({
      name: "local",
      state: "needs-auth",
      usesOAuth: true,
      hasOAuthCredentials: false,
    });
    const initial = service.startAuth(workspace, "local");
    const pending = await waitForAttempt(
      service,
      initial.attemptId,
      (attempt) => !!attempt.authorizationUrl && !!attempt.prompt,
    );
    expect(pending.status).toBe("pending");
    expect(new URL(pending.authorizationUrl!).searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(new URL(pending.authorizationUrl!).searchParams.get("state")).toBeTruthy();
    await service.completeAuth(initial.attemptId, issuer.callback(pending.authorizationUrl!));
    await waitForAttempt(service, initial.attemptId, (attempt) => attempt.status === "completed");
    await expectCallbackClosed(pending.authorizationUrl!);
    expect(issuer.errors).toEqual([]);
    expect(issuer.registrations).toHaveLength(1);
    expect(issuer.tokenRequests).toHaveLength(1);
    expect(issuer.rpcMethods).toContain("tools/list");
    const file = path.join(config.battyDir, ".batty", "mcp-auth.json");
    expect(
      JSON.parse(await fs.readFile(file, "utf8"))[`mcp__local|${new URL(issuer.url)}`].tokens
        .access_token,
    ).toBe("loopback-token");
    await expect(
      fs.stat(path.join(workspace.path, ".batty", "mcp-auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await service.reconnect(workspace, "local")).servers[0]).toMatchObject({
      state: "connected",
      hasOAuthCredentials: true,
      tools: [{ name: "echo" }],
    });
    const credentials = createBattyMcpCredentials(config);
    await credentials.forServer("unrelated", `${issuer.url}/other`).save({
      serverUrl: `${issuer.url}/other`,
      tokens: { access_token: "unrelated", token_type: "Bearer" },
    });
    expect((await service.logout(workspace, "local")).servers[0]).toMatchObject({
      hasOAuthCredentials: false,
    });
    expect(credentials.tokens("local", issuer.url)).toBeUndefined();
    expect(credentials.tokens("unrelated", `${issuer.url}/other`)?.access_token).toBe("unrelated");
    expect((await service.getStatus(workspace)).servers[0]?.state).toBe("needs-auth");
    expect(changed.mock.calls).toEqual([[workspace.id], [], [workspace.id], []]);
    await expect(service.completeAuth(initial.attemptId, "unused")).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it.each([
    { input: "not a URL", error: "Expected the full redirect URL" },
    { input: "wrong-state", error: "belongs to a different sign-in" },
    { input: "provider-error", error: "Access denied by fixture" },
  ])("reports invalid OAuth callbacks: $input", async ({ input, error }) => {
    const { service, workspace, config, changed } = await setup();
    const issuer = await oauthServer();
    await service.setServer(workspace, "local", { url: issuer.url });
    const attempt = service.startAuth(workspace, "local");
    const pending = await waitForAttempt(
      service,
      attempt.attemptId,
      (value) => !!value.authorizationUrl && !!value.prompt,
    );
    let callback =
      input === "not a URL" ? input : issuer.callback(pending.authorizationUrl!, "wrong-state");
    if (input === "provider-error") {
      const url = new URL(callback);
      url.searchParams.set("error", "access_denied");
      url.searchParams.set("error_description", "Access denied by fixture");
      callback = url.href;
    }
    await service.completeAuth(attempt.attemptId, callback);
    const failed = await waitForAttempt(
      service,
      attempt.attemptId,
      (value) => value.status === "failed",
    );
    expect(failed.error).toContain(error);
    expect(issuer.tokenRequests).toEqual([]);
    expect(createBattyMcpCredentials(config).tokens("local", issuer.url)).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(1);
    await expectCallbackClosed(pending.authorizationUrl!);
  });

  it("serializes sign-ins, cancels native prompts, and closes callbacks on disposal", async () => {
    const { service, workspace, changed } = await setup();
    const issuer = await oauthServer();
    await service.setServer(workspace, "local", { url: issuer.url });
    const first = service.startAuth(workspace, "local");
    await expect(service.completeAuth(first.attemptId, "early")).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(() => service.startAuth(workspace, "local")).toThrow("already pending");
    const pending = await waitForAttempt(
      service,
      first.attemptId,
      (value) => !!value.authorizationUrl && !!value.prompt,
    );
    expect((await service.cancelAuth(first.attemptId)).status).toBe("cancelled");
    await expectCallbackClosed(pending.authorizationUrl!);
    await expect(service.completeAuth(first.attemptId, "late")).rejects.toMatchObject({
      statusCode: 409,
    });
    const second = service.startAuth(workspace, "local");
    const next = await waitForAttempt(
      service,
      second.attemptId,
      (value) => !!value.authorizationUrl && !!value.prompt,
    );
    await service.dispose();
    expect(service.getAuthAttempt(second.attemptId).status).toBe("cancelled");
    await expectCallbackClosed(next.authorizationUrl!);
    expect(issuer.tokenRequests).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(() => service.startAuth(workspace, "local")).toThrow("closed");
    await expect(service.getStatus(workspace)).rejects.toThrow("closed");
    await service.dispose();
  });

  it("disposes a sign-in while its native control session is still opening", async () => {
    const { service, workspace } = await setup();
    const issuer = await oauthServer();
    await service.setServer(workspace, "local", { url: issuer.url });
    const attempt = service.startAuth(workspace, "local");
    await service.dispose();
    expect(service.getAuthAttempt(attempt.attemptId)).toMatchObject({ status: "cancelled" });
    expect(issuer.registrations).toEqual([]);
    expect(issuer.tokenRequests).toEqual([]);
  });
});
