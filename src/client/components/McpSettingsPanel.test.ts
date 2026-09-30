import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import McpSettingsPanel from "./McpSettingsPanel.vue";
import type { McpAuthAttempt, McpSettingsResponse, McpWorkspaceStatus } from "@/shared/types";

const workspace = {
  id: "workspace-1",
  label: "Project One",
  path: "/project-one",
  kind: "workspace" as const,
  isPinned: false,
  isAssistant: false,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function settings(servers: McpSettingsResponse["servers"] = []): McpSettingsResponse {
  return { servers, errors: [] };
}

function status(servers: McpWorkspaceStatus["servers"] = []): McpWorkspaceStatus {
  return { servers, errors: [] };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "confirm");
});

describe("McpSettingsPanel", () => {
  it("lists connection and tool status, adds a global server, and confirms deletion", async () => {
    const server: McpSettingsResponse["servers"][number] = {
      name: "docs",
      config: { type: "http", url: "https://mcp.example.test", exposure: "codemode" },
      scope: "global",
    };
    const workspaceOverride: McpSettingsResponse["servers"][number] = {
      name: "docs",
      config: { type: "http", url: "https://project.example.test" },
      scope: "workspace",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/settings/mcp") && init?.method === "PUT")
        return json(settings([server, { ...server, name: "added" }]));
      if (url.includes("/api/settings/mcp/docs") && init?.method === "DELETE")
        return json(settings());
      if (url.includes("/api/settings/mcp") && url.includes("workspaceId="))
        return json(settings([workspaceOverride]));
      if (url.includes("/api/settings/mcp")) return json(settings([server]));
      return json(
        status([
          {
            name: "docs",
            state: "connected",
            scope: "project",
            source: "/project-one/.batty/mcp.json",
            tools: [{ name: "search", exposure: "codemode", description: "Search docs" }],
          },
        ]),
      );
    });
    window.confirm = vi.fn(() => true);
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: workspace.id, workspaces: [workspace] },
    });
    await flushPromises();

    expect(wrapper.text()).toContain("Overridden in this workspace");
    expect(wrapper.text()).toContain("search");
    expect(wrapper.text()).toContain("codemode");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Edit")!
      .trigger("click");
    expect(wrapper.get('[aria-label="MCP server configuration"]').element).toHaveProperty(
      "value",
      expect.stringContaining("mcp.example.test"),
    );
    expect(wrapper.get('[aria-label="MCP server configuration"]').element).not.toHaveProperty(
      "value",
      expect.stringContaining("project.example.test"),
    );
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Cancel edit")!
      .trigger("click");
    for (const action of ["Reconnect", "Sign in", "Sign out"]) {
      expect(
        wrapper
          .findAll("button")
          .find((button) => button.text() === action)
          ?.attributes("disabled"),
      ).toBeDefined();
    }
    await wrapper.get('[aria-label="MCP server scope"]').setValue("workspace");
    expect(wrapper.text()).toContain("Workspace · Project One");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Edit")!
      .trigger("click");
    expect(wrapper.get('[aria-label="MCP server configuration"]').element).toHaveProperty(
      "value",
      expect.stringContaining("project.example.test"),
    );
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Cancel edit")!
      .trigger("click");
    await wrapper.get('[aria-label="MCP server scope"]').setValue("global");

    await wrapper.get('[aria-label="MCP server name"]').setValue("added");
    await wrapper.get('[aria-label="MCP server configuration"]').setValue(
      JSON.stringify({
        type: "stdio",
        command: "node",
        args: ["server.js"],
        exposure: "codemode",
      }),
    );
    await wrapper.get(".mcp-settings__form").trigger("submit");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/mcp/added"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          workspaceId: undefined,
          config: { type: "stdio", command: "node", args: ["server.js"], exposure: "codemode" },
        }),
      }),
    );

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Disable")!
      .trigger("click");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/mcp/docs"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          config: {
            type: "http",
            url: "https://mcp.example.test",
            exposure: "codemode",
            enabled: false,
          },
        }),
      }),
    );

    await wrapper.get('[aria-label="Remove docs"]').trigger("click");
    await flushPromises();
    expect(window.confirm).toHaveBeenCalledWith("Remove MCP server “docs”?");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/mcp/docs"),
      expect.objectContaining({ method: "DELETE" }),
    );
    wrapper.unmount();
  });

  it("saves workspace scope and completes OAuth through a pasted callback", async () => {
    const server: McpSettingsResponse["servers"][number] = {
      name: "calendar",
      config: { type: "http", url: "https://mcp.example.test", oauth: {} },
      scope: "workspace",
    };
    const auth: McpAuthAttempt = {
      attemptId: "attempt-1",
      workspaceId: workspace.id,
      serverName: "calendar",
      status: "pending",
      authorizationUrl: "https://auth.example.test/authorize",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/login")) return json(auth);
      if (url.endsWith("/api/mcp/auth/attempt-1") && init?.method === "POST")
        return json({ ...auth, status: "completed" });
      if (url.includes("/api/settings/mcp") && init?.method === "PUT")
        return json(settings([server]));
      if (url.includes("/api/settings/mcp") && url.includes("workspaceId="))
        return json(settings([server]));
      if (url.includes("/api/settings/mcp")) return json(settings());
      return json(status([{ name: "calendar", state: "connected", tools: [] }]));
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: workspace.id, workspaces: [workspace] },
    });
    await flushPromises();
    await wrapper.get('[aria-label="MCP server scope"]').setValue("workspace");
    await wrapper.get('[aria-label="MCP server name"]').setValue("calendar");
    await wrapper
      .get('[aria-label="MCP server configuration"]')
      .setValue(JSON.stringify(server.config));
    await wrapper.get(".mcp-settings__form").trigger("submit");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/mcp/calendar"),
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"workspaceId":"workspace-1"'),
      }),
    );

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Sign in")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.get(".mcp-settings__auth a").attributes("href")).toBe(auth.authorizationUrl);
    await wrapper
      .get('[aria-label="MCP OAuth callback URL"]')
      .setValue("http://localhost/callback?code=abc&state=server-checks");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Complete sign-in")!
      .trigger("click");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/mcp/auth/attempt-1"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          callbackUrl: "http://localhost/callback?code=abc&state=server-checks",
        }),
      }),
    );
    wrapper.unmount();
  });

  it("cancels OAuth attempts and ignores a settings response from a stale workspace", async () => {
    let releaseOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => {
      releaseOld = resolve;
    });
    let releaseOldStatus!: (response: Response) => void;
    const oldStatusResponse = new Promise<Response>((resolve) => {
      releaseOldStatus = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("workspaceId=workspace-1")) return oldResponse;
      if (url.includes("/api/workspaces/workspace-1/mcp")) return oldStatusResponse;
      if (url.endsWith("/login"))
        return Promise.resolve(
          json({
            attemptId: "attempt-cancel",
            workspaceId: "workspace-2",
            serverName: "fresh",
            status: "pending",
          }),
        );
      if (url.includes("/api/workspaces/workspace-2/mcp"))
        return Promise.resolve(json(status([{ name: "fresh", state: "connected", tools: [] }])));
      if (url.includes("workspaceId=workspace-2"))
        return Promise.resolve(
          json(
            settings([
              { name: "fresh", config: { type: "stdio", command: "fresh" }, scope: "workspace" },
            ]),
          ),
        );
      if (url.includes("/api/settings/mcp")) return Promise.resolve(json(settings()));
      if (url.endsWith("/api/mcp/auth/attempt-cancel"))
        return Promise.resolve(
          json({
            attemptId: "attempt-cancel",
            workspaceId: "workspace-2",
            serverName: "fresh",
            status: "cancelled",
          }),
        );
      return Promise.resolve(json(status()));
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1", workspaces: [workspace] },
    });
    await wrapper.setProps({ workspaceId: "workspace-2" });
    await wrapper.get('[aria-label="MCP server scope"]').setValue("workspace");
    await flushPromises();
    releaseOld(
      json(
        settings([
          { name: "stale", config: { type: "stdio", command: "old" }, scope: "workspace" },
        ]),
      ),
    );
    await flushPromises();
    releaseOldStatus(json(status([{ name: "fresh", state: "stale-workspace-status", tools: [] }])));
    await flushPromises();
    expect(wrapper.text()).toContain("fresh");
    expect(wrapper.text()).toContain("connected");
    expect(wrapper.text()).not.toContain("stale-workspace-status");

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Sign in")!
      .trigger("click");
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Cancel sign-in")!
      .trigger("click");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/mcp/auth/attempt-cancel"),
      expect.objectContaining({ method: "DELETE" }),
    );
    wrapper.unmount();
  });

  it("keeps OAuth polling alive across a server refresh and opens the global server sign-in URL", async () => {
    vi.useFakeTimers();
    const globalServer: McpSettingsResponse["servers"][number] = {
      name: "shared-login",
      config: { type: "http", url: "https://mcp.example.test", oauth: {} },
      scope: "global",
    };
    const auth: McpAuthAttempt = {
      attemptId: "refresh-attempt",
      workspaceId: workspace.id,
      serverName: globalServer.name,
      status: "pending",
      authorizationUrl: "https://auth.example.test/refresh",
    };
    let pollCount = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/settings/mcp") && url.includes("workspaceId="))
        return json(settings());
      if (url.includes("/api/settings/mcp")) return json(settings([globalServer]));
      if (url.endsWith("/login")) return json(auth);
      if (url.endsWith("/api/mcp/auth/refresh-attempt")) {
        pollCount++;
        return json(auth);
      }
      return json(status([{ name: globalServer.name, state: "connected", tools: [] }]));
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: workspace.id, workspaces: [workspace] },
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Sign in")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.get(".mcp-settings__auth a").attributes("href")).toBe(auth.authorizationUrl);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Refresh servers")!
      .trigger("click");
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(pollCount).toBe(1);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/settings/mcp?workspaceId=workspace-1"),
      ),
    ).toBe(true);
    wrapper.unmount();
  });

  it("resumes OAuth polling after callback submission reports a retryable error", async () => {
    vi.useFakeTimers();
    const server: McpSettingsResponse["servers"][number] = {
      name: "retry-login",
      config: { type: "http", url: "https://mcp.example.test", oauth: {} },
      scope: "global",
    };
    const auth: McpAuthAttempt = {
      attemptId: "retry-attempt",
      workspaceId: workspace.id,
      serverName: server.name,
      status: "pending",
      authorizationUrl: "https://auth.example.test/retry",
    };
    let pollCount = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/settings/mcp") && url.includes("workspaceId="))
        return json(settings());
      if (url.includes("/api/settings/mcp")) return json(settings([server]));
      if (url.endsWith("/login")) return json(auth);
      if (url.endsWith("/api/mcp/auth/retry-attempt") && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "OAuth callback is not ready" }), {
          status: 409,
        });
      }
      if (url.endsWith("/api/mcp/auth/retry-attempt")) {
        pollCount++;
        return json(auth);
      }
      return json(status());
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: workspace.id, workspaces: [workspace] },
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Sign in")!
      .trigger("click");
    await flushPromises();
    await wrapper
      .get('[aria-label="MCP OAuth callback URL"]')
      .setValue("http://localhost/callback?code=pending");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Complete sign-in")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("OAuth callback is not ready");
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(pollCount).toBe(1);
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/api/mcp/auth/retry-attempt")),
    ).toBe(true);
    wrapper.unmount();
  });
});
