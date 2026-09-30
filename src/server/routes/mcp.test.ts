import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { RouteContext } from "./context";
import { registerMcpRoutes } from "./mcp";

const roots: string[] = [];
const attempt = {
  attemptId: "attempt-1",
  workspaceId: "workspace",
  serverName: "docs",
  status: "pending",
  authorizationUrl: "https://example.com/auth",
};
const status = { servers: [{ name: "docs", state: "connected", tools: [] }], errors: [] };

async function fixture(authRequired = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-mcp-route-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspaces");
  await fs.mkdir(path.join(workspaceRoot, "workspace"), { recursive: true });
  const app = Fastify();
  if (authRequired) {
    app.addHook("onRequest", async (request, reply) => {
      if (request.headers.authorization !== "Bearer test") {
        reply.code(401).send({ error: "Authentication required" });
      }
    });
  }
  const mcp = {
    readSettings: vi.fn(async (workspace?: { id: string }) => ({
      servers: [],
      errors: [],
      scope: workspace ? "workspace" : "global",
    })),
    setServer: vi.fn(
      async (workspace: { id: string } | undefined, name: string, config: unknown) => ({
        name,
        config,
        scope: workspace ? "workspace" : "global",
      }),
    ),
    removeServer: vi.fn(async (workspace: { id: string } | undefined, name: string) => ({
      removed: true,
      name,
      scope: workspace ? "workspace" : "global",
    })),
    getStatus: vi.fn(async () => status),
    reconnect: vi.fn(async () => status),
    logout: vi.fn(async () => status),
    startAuth: vi.fn(async () => attempt),
    getAuthAttempt: vi.fn(async () => attempt),
    completeAuth: vi.fn(async () => ({ ...attempt, status: "completed" })),
    cancelAuth: vi.fn(async () => ({ ...attempt, status: "cancelled" })),
  };
  const config = { battyDir: root, workspacesRoots: [workspaceRoot] };
  const context = {
    app,
    config,
    service: { mcp },
    routePath: (route: string) => route,
  } as unknown as RouteContext;
  registerMcpRoutes(context);
  return { app, mcp };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("MCP routes", () => {
  it("reads and edits global and workspace server settings", async () => {
    const { app, mcp } = await fixture();
    try {
      const global = await app.inject({ method: "GET", url: "/api/settings/mcp" });
      expect(global.json()).toMatchObject({ scope: "global" });
      expect(mcp.readSettings).toHaveBeenCalledWith(undefined);

      const workspace = await app.inject({
        method: "GET",
        url: "/api/settings/mcp?workspaceId=workspace",
      });
      expect(workspace.json()).toMatchObject({ scope: "workspace" });
      const config = { command: "node", args: ["server.js"] };
      const set = await app.inject({
        method: "PUT",
        url: "/api/settings/mcp/docs",
        payload: { workspaceId: "workspace", config },
      });
      expect(set.json()).toMatchObject({ name: "docs", config, scope: "workspace" });
      expect(mcp.setServer).toHaveBeenCalledWith(
        expect.objectContaining({ id: "workspace" }),
        "docs",
        config,
      );

      const removed = await app.inject({
        method: "DELETE",
        url: "/api/settings/mcp/docs?workspaceId=workspace",
      });
      expect(removed.json()).toMatchObject({ removed: true, scope: "workspace" });
      expect(mcp.removeServer).toHaveBeenCalledWith(
        expect.objectContaining({ id: "workspace" }),
        "docs",
      );
    } finally {
      await app.close();
    }
  });

  it("rejects invalid names, malformed bodies, and unknown workspaces", async () => {
    const { app, mcp } = await fixture();
    try {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/settings/mcp/bad.name",
            payload: { config: {} },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/settings/mcp/docs",
            payload: { config: null },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ method: "GET", url: "/api/settings/mcp?workspaceId=missing" }))
          .statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: "GET", url: "/api/workspaces/missing/mcp" })).statusCode,
      ).toBe(404);
      expect(mcp.setServer).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("delegates workspace runtime status, reconnection, logout, and login", async () => {
    const { app, mcp } = await fixture();
    try {
      expect(
        (await app.inject({ method: "GET", url: "/api/workspaces/workspace/mcp" })).json(),
      ).toEqual(status);
      expect(
        (
          await app.inject({ method: "POST", url: "/api/workspaces/workspace/mcp/docs/reconnect" })
        ).json(),
      ).toEqual(status);
      expect(
        (
          await app.inject({ method: "POST", url: "/api/workspaces/workspace/mcp/docs/logout" })
        ).json(),
      ).toEqual(status);
      expect(
        (
          await app.inject({ method: "POST", url: "/api/workspaces/workspace/mcp/docs/login" })
        ).json(),
      ).toEqual(attempt);
      expect(mcp.reconnect).toHaveBeenCalledWith(
        expect.objectContaining({ id: "workspace" }),
        "docs",
      );
      expect(mcp.logout).toHaveBeenCalledWith(expect.objectContaining({ id: "workspace" }), "docs");
      expect(mcp.startAuth).toHaveBeenCalledWith(
        expect.objectContaining({ id: "workspace" }),
        "docs",
      );
    } finally {
      await app.close();
    }
  });

  it("gets, completes, and cancels OAuth attempts", async () => {
    const { app, mcp } = await fixture();
    try {
      expect((await app.inject({ method: "GET", url: "/api/mcp/auth/attempt-1" })).json()).toEqual(
        attempt,
      );
      const callbackUrl = "http://127.0.0.1:3000/callback?code=abc&state=xyz";
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/mcp/auth/attempt-1",
            payload: { callbackUrl },
          })
        ).json(),
      ).toMatchObject({ status: "completed" });
      expect(mcp.completeAuth).toHaveBeenCalledWith("attempt-1", callbackUrl);
      expect(
        (await app.inject({ method: "POST", url: "/api/mcp/auth/attempt-1", payload: {} }))
          .statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ method: "DELETE", url: "/api/mcp/auth/attempt-1" })).json(),
      ).toMatchObject({ status: "cancelled" });
    } finally {
      await app.close();
    }
  });

  it("keeps every endpoint behind the auth hook", async () => {
    const { app } = await fixture(true);
    try {
      const paths: Array<[string, string]> = [
        ["GET", "/api/settings/mcp"],
        ["PUT", "/api/settings/mcp/docs"],
        ["DELETE", "/api/settings/mcp/docs"],
        ["GET", "/api/workspaces/workspace/mcp"],
        ["POST", "/api/workspaces/workspace/mcp/docs/login"],
        ["GET", "/api/mcp/auth/attempt-1"],
        ["POST", "/api/mcp/auth/attempt-1"],
        ["DELETE", "/api/mcp/auth/attempt-1"],
      ];
      for (const [method, url] of paths) {
        const response = await app.inject({ method: method as "GET", url, payload: {} });
        expect(response.statusCode, `${method} ${url}`).toBe(401);
      }
    } finally {
      await app.close();
    }
  });
});
