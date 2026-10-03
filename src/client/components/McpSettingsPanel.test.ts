import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import McpSettingsPanel from "./McpSettingsPanel.vue";
import type { McpAuthAttempt, McpSettingsResponse, McpWorkspaceStatus } from "@/shared/types";
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
});

const workspace = { id: "workspace-1" };

describe("McpSettingsPanel OAuth and stale responses", () => {
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
            usesOAuth: true,
            hasOAuthCredentials: true,
            scope: "project",
            source: "/project-one/.batty/mcp.json",
            tools: [{ name: "search", exposure: "codemode", description: "Search docs" }],
          },
        ]),
      );
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: workspace.id },
    });
    await flushPromises();

    expect(wrapper.text()).toContain("Overridden in this workspace");
    expect(wrapper.text()).toContain("search");
    expect(wrapper.text()).not.toContain("codemode");
    const toolButtons = wrapper.findAll('[aria-label="Show tools for docs"]');
    expect(toolButtons).toHaveLength(2);
    const targets = toolButtons.map((button) => button.attributes("popovertarget"));
    expect(new Set(targets).size).toBe(2);
    for (const [index, card] of wrapper.findAll(".mcp-settings__server").entries()) {
      expect(toolButtons[index]!.text()).toBe("Tools (1)");
      const popover = card.get(`[id="${targets[index]}"]`);
      expect(popover.attributes("id")).toBe(targets[index]);
      expect(popover.get(".mcp-settings__tools").text()).toContain("Search docs");
      expect(card.find(".mcp-settings__server-head .mcp-settings__tools").exists()).toBe(false);
    }
    await wrapper.findAll('[aria-label="Edit docs"]')[0]!.trigger("click");
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
      .find((button) => button.text() === "Cancel")!
      .trigger("click");
    for (const action of ["Reconnect", "Sign in", "Sign out"]) {
      expect(
        wrapper
          .findAll(".mcp-settings__server")[0]!
          .findAll("button")
          .some((button) => button.text() === action),
      ).toBe(false);
    }
    expect(wrapper.text()).toContain("Workspace");
    await wrapper.findAll('[aria-label="Edit docs"]')[1]!.trigger("click");
    expect(wrapper.get('[aria-label="MCP server configuration"]').element).toHaveProperty(
      "value",
      expect.stringContaining("project.example.test"),
    );
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Cancel")!
      .trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Add server")!
      .trigger("click");

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

    await wrapper.findAll('[aria-label="Enabled docs"]')[0]!.setValue(false);
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

    await wrapper.findAll('[aria-label="Remove docs"]')[0]!.trigger("click");
    const confirmation = wrapper.findAll('button[aria-label="Confirm: Remove docs"]')[0]!;
    (confirmation.element.parentElement as HTMLElement).hidePopover = vi.fn();
    await confirmation.trigger("click");
    await flushPromises();
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
      return json(
        status([
          {
            name: "calendar",
            state: "needs-auth",
            usesOAuth: true,
            hasOAuthCredentials: false,
            tools: [],
          },
        ]),
      );
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: workspace.id },
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Add server")!
      .trigger("click");
    await wrapper.get('[aria-label="Global server"]').setValue(false);
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
    expect(wrapper.find(".mcp-settings__auth").exists()).toBe(false);
    wrapper.unmount();
  });

  it.each(["poll", "callback", "start"] as const)(
    "closes the sign-in panel on %s success before refreshing connection status",
    async (completion) => {
      vi.useFakeTimers();
      const server: McpSettingsResponse["servers"][number] = {
        name: "successful-login",
        config: { type: "http", url: "https://mcp.example.test", oauth: {} },
        scope: "global",
      };
      const auth: McpAuthAttempt = {
        attemptId: "successful-attempt",
        workspaceId: workspace.id,
        serverName: server.name,
        status: "pending",
        authorizationUrl: "https://auth.example.test/authorize",
      };
      let statusRequests = 0;
      let releaseStatus!: (response: Response) => void;
      const refreshedStatus = new Promise<Response>((resolve) => {
        releaseStatus = resolve;
      });
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/api/settings/mcp") && url.includes("workspaceId="))
          return json(settings());
        if (url.includes("/api/settings/mcp")) return json(settings([server]));
        if (url.endsWith("/login"))
          return json({ ...auth, status: completion === "start" ? "completed" : "pending" });
        if (url.endsWith("/api/mcp/auth/successful-attempt"))
          return json({ ...auth, status: "completed" });
        statusRequests++;
        if (statusRequests > 1) return refreshedStatus;
        return json(
          status([
            {
              name: server.name,
              state: "needs-auth",
              usesOAuth: true,
              hasOAuthCredentials: false,
              tools: [],
            },
          ]),
        );
      });
      const wrapper = mount(McpSettingsPanel, {
        props: { active: true, workspaceId: workspace.id },
      });
      await flushPromises();
      await wrapper
        .findAll("button")
        .find((button) => button.text() === "Sign in")!
        .trigger("click");
      await flushPromises();

      if (completion !== "start") {
        expect(wrapper.find(".mcp-settings__auth").exists()).toBe(true);
        await wrapper
          .get('[aria-label="MCP OAuth callback URL"]')
          .setValue("http://localhost/callback?code=abc&state=server-checks");
        if (completion === "callback") {
          await wrapper
            .findAll("button")
            .find((button) => button.text() === "Complete sign-in")!
            .trigger("click");
        } else {
          await vi.advanceTimersByTimeAsync(1000);
        }
        await flushPromises();
      }

      expect(statusRequests).toBe(2);
      expect(wrapper.find(".mcp-settings__auth").exists()).toBe(false);
      expect(wrapper.find('[aria-label="MCP OAuth callback URL"]').exists()).toBe(false);
      expect(fetchMock).toHaveBeenCalledWith(`/api/workspaces/${workspace.id}/mcp`, {
        credentials: "include",
      });

      releaseStatus(
        json(
          status([
            {
              name: server.name,
              state: "connected",
              usesOAuth: true,
              hasOAuthCredentials: true,
              tools: [],
            },
          ]),
        ),
      );
      await flushPromises();
      expect(wrapper.text()).toContain("Connected");
      expect(wrapper.find(".mcp-settings__auth").exists()).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(statusRequests).toBe(2);
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).endsWith("/api/mcp/auth/successful-attempt"),
        ),
      ).toHaveLength(completion === "start" ? 0 : 1);
      wrapper.unmount();
    },
  );

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
        return Promise.resolve(
          json(
            status([
              {
                name: "fresh",
                state: "needs-auth",
                usesOAuth: true,
                hasOAuthCredentials: false,
                tools: [],
              },
            ]),
          ),
        );
      if (url.includes("workspaceId=workspace-2"))
        return Promise.resolve(
          json(
            settings([
              {
                name: "fresh",
                config: { type: "http", url: "https://fresh.example.test/mcp" },
                scope: "workspace",
              },
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
      props: { active: true, workspaceId: "workspace-1" },
    });
    await wrapper.setProps({ workspaceId: "workspace-2" });
    await flushPromises();
    releaseOld(
      json(
        settings([
          { name: "stale", config: { type: "stdio", command: "old" }, scope: "workspace" },
        ]),
      ),
    );
    await flushPromises();
    releaseOldStatus(
      json(
        status([
          {
            name: "fresh",
            state: "stale-workspace-status",
            usesOAuth: true,
            hasOAuthCredentials: false,
            tools: [],
          },
        ]),
      ),
    );
    await flushPromises();
    expect(wrapper.text()).toContain("fresh");
    expect(wrapper.text()).toContain("Sign-in required");
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

  it("keeps OAuth polling alive across a configuration-triggered refresh and opens the global server sign-in URL", async () => {
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
      return json(
        status([
          {
            name: globalServer.name,
            state: "needs-auth",
            usesOAuth: true,
            hasOAuthCredentials: false,
            tools: [],
          },
        ]),
      );
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: workspace.id },
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Sign in")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.get(".mcp-settings__auth a").attributes("href")).toBe(auth.authorizationUrl);
    await wrapper.get('[aria-label="Enabled shared-login"]').setValue(false);
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
      return json(
        status([
          {
            name: server.name,
            state: "needs-auth",
            usesOAuth: true,
            hasOAuthCredentials: false,
            tools: [],
          },
        ]),
      );
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: workspace.id },
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

describe("McpSettingsPanel", () => {
  it("mutates globals without touching a same-name selected workspace override", async () => {
    const globalConfig = { type: "stdio" as const, command: "global" };
    const workspaceConfig = { type: "stdio" as const, command: "project" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (init?.method === "PUT" || init?.method === "DELETE") return json(settings());
      const url = String(input);
      if (url.includes("/api/settings/mcp"))
        return json(
          settings(
            url.includes("workspaceId=workspace-1")
              ? [{ name: "shared", config: workspaceConfig, scope: "workspace" }]
              : url.includes("workspaceId=")
                ? []
                : [{ name: "shared", config: globalConfig, scope: "global" }],
          ),
        );
      return json(
        status([
          {
            name: "shared",
            scope: "project",
            state: "connected",
            usesOAuth: false,
            hasOAuthCredentials: false,
            tools: [],
          },
        ]),
      );
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1" },
    });
    await flushPromises();
    await wrapper.findAll('[aria-label="Enabled shared"]')[0]!.setValue(false);
    await flushPromises();
    await wrapper
      .findAll(".mcp-settings__server")[0]!
      .get('[aria-label="Remove shared"]')
      .trigger("click");
    const confirmation = wrapper.findAll('button[aria-label="Confirm: Remove shared"]')[0]!;
    (confirmation.element.parentElement as HTMLElement).hidePopover = vi.fn();
    await confirmation.trigger("click");
    await flushPromises();
    const mutations = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "PUT" || init?.method === "DELETE",
    );
    expect(mutations).toHaveLength(2);
    expect(mutations[0]).toEqual([
      "/api/settings/mcp/shared",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ config: { ...globalConfig, enabled: false } }),
      }),
    ]);
    expect(mutations[1]).toEqual([
      "/api/settings/mcp/shared",
      expect.objectContaining({ method: "DELETE" }),
    ]);
    expect(wrapper.findAll(".mcp-settings__server")[1]!.text()).toContain("Workspace");
    wrapper.unmount();
  });

  it("ignores a runtime response after the workspace selection changes", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/reconnect")) return pending;
      if (url.includes("/api/settings/mcp"))
        return json(
          settings(
            url.includes("workspaceId=")
              ? [{ name: "other", scope: "workspace", config: { type: "stdio", command: "node" } }]
              : [],
          ),
        );
      return json(
        status([
          {
            name: "other",
            state: "connected",
            usesOAuth: false,
            hasOAuthCredentials: false,
            tools: [],
          },
        ]),
      );
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1" },
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Reconnect")!
      .trigger("click");
    await wrapper.setProps({ workspaceId: "workspace-2" });
    await flushPromises();
    release(
      json(
        status([
          {
            name: "other",
            state: "stale",
            usesOAuth: false,
            hasOAuthCredentials: false,
            error: "Stale runtime error",
            tools: [],
          },
        ]),
      ),
    );
    await flushPromises();
    expect(wrapper.text()).toContain("Connected");
    expect(wrapper.text()).not.toContain("Stale runtime error");
    wrapper.unmount();
  });

  it("lists globals without a current workspace and refuses workspace-scoped creation", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        json(
          settings([
            { name: "global", scope: "global", config: { type: "stdio", command: "node" } },
          ]),
        ),
      );
    const wrapper = mount(McpSettingsPanel, { props: { active: true } });
    await flushPromises();
    expect(wrapper.text()).toContain("global");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/mcp", expect.anything());
    expect(wrapper.text()).not.toContain("Reconnect");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Add server")!
      .trigger("click");
    await wrapper.get('[aria-label="Global server"]').setValue(false);
    await wrapper.get('[aria-label="MCP server name"]').setValue("draft");
    await wrapper
      .get('[aria-label="MCP server configuration"]')
      .setValue('{"type":"stdio","command":"node"}');
    expect(wrapper.find("select").exists()).toBe(false);
    expect(wrapper.get('button[type="submit"]').attributes("disabled")).toBeDefined();
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    expect(wrapper.text()).toContain("Select a workspace");
    wrapper.unmount();
  });

  it("shows OAuth only on the effective workspace row when it overrides a global name", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/login"))
        return json({
          attemptId: "override-auth",
          workspaceId: "workspace-1",
          serverName: "shared",
          status: "pending",
        });
      if (url.includes("/api/settings/mcp"))
        return json(
          settings(
            url.includes("workspaceId=workspace-2")
              ? []
              : [
                  {
                    name: "shared",
                    scope: url.includes("workspaceId=") ? "workspace" : "global",
                    config: { type: "http", url: "https://mcp.example", oauth: {} },
                  },
                ],
          ),
        );
      return json(
        status([
          {
            name: "shared",
            scope: "project",
            state: "needs-auth",
            usesOAuth: true,
            hasOAuthCredentials: false,
            tools: [],
          },
        ]),
      );
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1" },
    });
    await flushPromises();
    const cards = wrapper.findAll(".mcp-settings__server");
    expect(cards[0]!.findAll("button").some((button) => button.text() === "Sign in")).toBe(false);
    await cards[1]!
      .findAll("button")
      .find((button) => button.text() === "Sign in")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.findAll(".mcp-settings__auth")).toHaveLength(1);
    expect(cards[0]!.find(".mcp-settings__auth").exists()).toBe(false);
    expect(cards[1]!.find(".mcp-settings__auth").exists()).toBe(true);
    wrapper.unmount();
  });

  it("lists globals and only the current workspace servers, with globals first", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("workspaceId=workspace-1"))
        return json(
          settings([
            { name: "zeta", config: { type: "stdio", command: "zeta" }, scope: "workspace" },
          ]),
        );
      if (url.includes("workspaceId=workspace-2"))
        return json(
          settings([
            { name: "alpha", config: { type: "stdio", command: "alpha" }, scope: "workspace" },
          ]),
        );
      if (url.includes("/api/settings/mcp"))
        return json(
          settings([
            { name: "global", config: { type: "stdio", command: "global" }, scope: "global" },
          ]),
        );
      return json(status());
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1" },
    });
    await flushPromises();
    const names = wrapper.findAll(".mcp-settings__server-meta strong").map((item) => item.text());
    expect(names).toEqual(["global", "zeta"]);
    expect(wrapper.text()).toContain("Workspace");
    expect(wrapper.text()).not.toContain("alpha");
    expect(wrapper.findAll('[aria-label^="Show tools for"]')).toHaveLength(0);
    expect(wrapper.findAll(".mcp-settings__tools-popover")).toHaveLength(0);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("workspaceId=workspace-1")),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("workspaceId=workspace-2")),
    ).toBe(false);
    expect(wrapper.text()).not.toContain("Refresh servers");
    await wrapper.setProps({ workspaceId: "workspace-2" });
    await flushPromises();
    expect(wrapper.findAll(".mcp-settings__server-meta strong").map((item) => item.text())).toEqual(
      ["global", "alpha"],
    );
    expect(wrapper.text()).not.toContain("zeta");
    await wrapper.setProps({ workspaceId: undefined });
    await flushPromises();
    expect(wrapper.findAll(".mcp-settings__server-meta strong").map((item) => item.text())).toEqual(
      ["global"],
    );
    wrapper.unmount();
  });

  it("keeps creation collapsed and uses the current workspace when Global is off", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        json(String(input).includes("/api/settings/mcp") ? settings() : status()),
      );
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1" },
    });
    await flushPromises();
    expect(wrapper.find('[aria-label="MCP server name"]').exists()).toBe(false);
    await wrapper.get("button").trigger("click");
    expect(wrapper.get('[aria-label="Global server"]').element).toHaveProperty("checked", true);
    const saveButton = wrapper.get('button[type="submit"]');
    expect(saveButton.classes()).toContain("mcp-editor__save");
    expect(saveButton.find("svg").exists()).toBe(true);
    const scopeRow = wrapper.get(".mcp-editor__switch");
    expect(scopeRow.get('[role="switch"]').attributes("aria-label")).toBe("Global server");
    expect(scopeRow.get(".mcp-editor__switch-track").attributes("aria-hidden")).toBe("true");
    await wrapper.get('[aria-label="Global server"]').setValue(false);
    expect(wrapper.find("select").exists()).toBe(false);
    await wrapper.setProps({ workspaceId: "workspace-2" });
    await flushPromises();
    await wrapper.get('[aria-label="MCP server name"]').setValue("new-project-server");
    await wrapper
      .get('[aria-label="MCP server configuration"]')
      .setValue('{"type":"stdio","command":"node"}');
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings/mcp/new-project-server",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          workspaceId: "workspace-2",
          config: { type: "stdio", command: "node", exposure: "codemode" },
        }),
      }),
    );
    expect(wrapper.find('[aria-label="MCP server name"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("edits and removes servers only in the current workspace", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "PUT" || init?.method === "DELETE") return json(settings());
      if (url.includes("workspaceId=workspace-1"))
        return json(
          settings([
            { name: "one", config: { type: "stdio", command: "one" }, scope: "workspace" },
          ]),
        );
      if (url.includes("workspaceId=workspace-2"))
        return json(
          settings([
            { name: "two", config: { type: "stdio", command: "two" }, scope: "workspace" },
          ]),
        );
      if (url.includes("/api/settings/mcp")) return json(settings());
      return json(status());
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1" },
    });
    await flushPromises();
    expect(wrapper.text()).not.toContain("two");
    await wrapper.setProps({ workspaceId: "workspace-2" });
    await flushPromises();
    const two = wrapper.get(".mcp-settings__server");
    await two.get('[aria-label="Edit two"]').trigger("click");
    expect(wrapper.get('[aria-label="MCP server configuration"]').element).toHaveProperty(
      "value",
      expect.stringContaining('"two"'),
    );
    await wrapper.get(".mcp-settings__form").trigger("submit");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/mcp/two"),
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"workspaceId":"workspace-2"'),
      }),
    );
    const updatedCard = wrapper.get(".mcp-settings__server");
    await updatedCard.get('[aria-label="Remove two"]').trigger("click");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    const confirmation = updatedCard.get('button[aria-label="Confirm: Remove two"]');
    (confirmation.element.parentElement as HTMLElement).hidePopover = vi.fn();
    await confirmation.trigger("click");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/mcp/two?workspaceId=workspace-2"),
      expect.objectContaining({ method: "DELETE" }),
    );
    wrapper.unmount();
  });

  it.each([
    { state: "connected", usesOAuth: false, hasOAuthCredentials: false, actions: ["Reconnect"] },
    { state: "connected", usesOAuth: true, hasOAuthCredentials: false, actions: ["Reconnect"] },
    {
      state: "connected",
      usesOAuth: true,
      hasOAuthCredentials: true,
      actions: ["Reconnect", "Sign out"],
    },
    {
      state: "needs-auth",
      usesOAuth: true,
      hasOAuthCredentials: false,
      actions: ["Reconnect", "Sign in"],
    },
    {
      state: "needs-auth",
      usesOAuth: true,
      hasOAuthCredentials: true,
      actions: ["Reconnect", "Sign in", "Sign out"],
    },
    { state: "failed", usesOAuth: false, hasOAuthCredentials: false, actions: ["Reconnect"] },
    { state: "disconnected", usesOAuth: false, hasOAuthCredentials: false, actions: ["Reconnect"] },
    { state: "disabled", usesOAuth: true, hasOAuthCredentials: true, actions: [] },
    { state: "connecting", usesOAuth: true, hasOAuthCredentials: true, actions: [] },
    { state: "closed", usesOAuth: true, hasOAuthCredentials: true, actions: [] },
  ])(
    "shows relevant connection actions for $state / OAuth $usesOAuth / credentials $hasOAuthCredentials",
    async ({ actions, ...runtime }) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/api/settings/mcp"))
          return json(
            settings(
              url.includes("workspaceId=")
                ? []
                : [
                    {
                      name: "docs",
                      scope: "global",
                      config: { url: "https://docs.example.test/mcp" },
                    },
                  ],
            ),
          );
        return json(status([{ name: "docs", ...runtime, tools: [] }]));
      });
      const wrapper = mount(McpSettingsPanel, {
        props: { active: true, workspaceId: workspace.id },
      });
      await flushPromises();
      const buttons = wrapper
        .get(".mcp-settings__server")
        .findAll("button")
        .map((button) => button.text());
      for (const action of ["Reconnect", "Sign in", "Sign out"]) {
        expect(buttons.includes(action)).toBe(actions.includes(action));
      }
      wrapper.unmount();
    },
  );

  it("labels a server missing from inspected runtime status as Not connected", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/settings/mcp"))
        return json(
          settings(
            url.includes("workspaceId=")
              ? []
              : [
                  {
                    name: "docs",
                    scope: "global",
                    config: { command: "node" },
                  },
                ],
          ),
        );
      return json(status());
    });
    const wrapper = mount(McpSettingsPanel, { props: { active: true, workspaceId: workspace.id } });
    await flushPromises();
    expect(wrapper.get(".mcp-settings__server").text()).toContain("Not connected");
    expect(wrapper.get(".mcp-settings__server").text()).not.toContain("Not inspected");
    wrapper.unmount();
  });

  it("disables Add server while an inline save is pending", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (init?.method === "PUT") return pending;
      const url = String(input);
      if (url.includes("/api/settings/mcp"))
        return json(
          settings(
            url.includes("workspaceId=")
              ? []
              : [
                  {
                    name: "docs",
                    scope: "global",
                    config: { command: "node" },
                  },
                ],
          ),
        );
      return json(status());
    });
    const wrapper = mount(McpSettingsPanel, { props: { active: true, workspaceId: workspace.id } });
    await flushPromises();
    await wrapper.get('[aria-label="Edit docs"]').trigger("click");
    await wrapper.get(".mcp-settings__form").trigger("submit");
    await flushPromises();
    const add = wrapper.findAll("button").find((button) => button.text() === "Add server")!;
    expect(add.attributes("disabled")).toBeDefined();
    await add.trigger("click");
    expect(wrapper.get(".mcp-settings__server").find(".mcp-settings__form").exists()).toBe(true);
    expect(wrapper.findAll(".mcp-settings__form")).toHaveLength(1);
    release(json(settings()));
    await flushPromises();
    expect(add.attributes("disabled")).toBeUndefined();
    expect(wrapper.find(".mcp-settings__form").exists()).toBe(false);
    wrapper.unmount();
  });

  it.each([false, true])(
    "rolls back a failed scope move with rollback failure %s",
    async (rollbackFails) => {
      let destinationExists = false;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (init?.method === "PUT") {
          destinationExists = true;
          return json(settings());
        }
        if (init?.method === "DELETE") {
          if (!url.includes("workspaceId="))
            return new Response(JSON.stringify({ error: "Source delete failed" }), { status: 500 });
          if (rollbackFails)
            return new Response(JSON.stringify({ error: "Destination rollback failed" }), {
              status: 500,
            });
          destinationExists = false;
          return json(settings());
        }
        if (url.includes("/api/settings/mcp"))
          return json(
            settings(
              url.includes("workspaceId=")
                ? destinationExists
                  ? [
                      {
                        name: "docs",
                        scope: "workspace",
                        config: { command: "node", exposure: "codemode" },
                      },
                    ]
                  : []
                : [{ name: "docs", scope: "global", config: { command: "node" } }],
            ),
          );
        return json(status());
      });
      const wrapper = mount(McpSettingsPanel, {
        props: { active: true, workspaceId: workspace.id },
      });
      await flushPromises();
      const initialSettingsReads = fetchMock.mock.calls.filter(
        ([input, init]) => String(input).includes("/api/settings/mcp") && !init?.method,
      ).length;
      await wrapper.get('[aria-label="Edit docs"]').trigger("click");
      await wrapper.get('[aria-label="Global server"]').setValue(false);
      await wrapper.get(".mcp-settings__form").trigger("submit");
      await flushPromises();
      const mutations = fetchMock.mock.calls.filter(([, init]) =>
        ["PUT", "DELETE"].includes(init?.method ?? ""),
      );
      expect(mutations.map(([url, init]) => [url, init?.method])).toEqual([
        ["/api/settings/mcp/docs", "PUT"],
        ["/api/settings/mcp/docs", "DELETE"],
        [`/api/settings/mcp/docs?workspaceId=${workspace.id}`, "DELETE"],
      ]);
      expect(wrapper.text()).toContain("Source delete failed");
      expect(wrapper.find(".mcp-settings__form").exists()).toBe(true);
      expect(wrapper.get('[aria-label="Global server"]').element).toHaveProperty("checked", false);
      const settingsReads = fetchMock.mock.calls.filter(
        ([input, init]) => String(input).includes("/api/settings/mcp") && !init?.method,
      ).length;
      if (rollbackFails) {
        expect(wrapper.text()).toContain("Destination rollback failed");
        expect(settingsReads).toBeGreaterThan(initialSettingsReads);
        expect(wrapper.findAll(".mcp-settings__server")).toHaveLength(2);
      } else {
        expect(wrapper.text()).not.toContain("Destination rollback failed");
        expect(settingsReads).toBe(initialSettingsReads);
        expect(wrapper.findAll(".mcp-settings__server")).toHaveLength(1);
      }
      wrapper.unmount();
    },
  );

  it.each([true, false])(
    "edits inline and moves a server with Global set to %s",
    async (global) => {
      const sourceScope = global ? "workspace" : "global";
      const config = {
        type: "http" as const,
        url: "https://docs.example.test/mcp",
        exposure: "direct" as const,
      };
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/api/settings/mcp"))
          return json(
            settings(
              url.includes("workspaceId=") === (sourceScope === "workspace")
                ? [{ name: "docs", scope: sourceScope, config }]
                : [],
            ),
          );
        return json(status());
      });
      const wrapper = mount(McpSettingsPanel, {
        props: { active: true, workspaceId: workspace.id },
      });
      await flushPromises();
      expect(wrapper.find(".mcp-settings__form").exists()).toBe(false);
      await wrapper.get('[aria-label="Edit docs"]').trigger("click");
      const card = wrapper.get(".mcp-settings__server");
      expect(card.find(".mcp-settings__form").exists()).toBe(true);
      expect(wrapper.findAll(".mcp-settings__form")).toHaveLength(1);
      expect(card.find('[aria-label="MCP server name"]').exists()).toBe(false);
      expect(
        JSON.parse(
          (card.get('[aria-label="MCP server configuration"]').element as HTMLTextAreaElement)
            .value,
        ),
      ).toEqual({ type: "http", url: config.url });
      await card.get('[aria-label="Global server"]').setValue(global);
      await card.get(".mcp-settings__form").trigger("submit");
      await flushPromises();
      const mutations = fetchMock.mock.calls.filter(([, init]) =>
        ["PUT", "DELETE"].includes(init?.method ?? ""),
      );
      expect(mutations).toEqual([
        [
          "/api/settings/mcp/docs",
          expect.objectContaining({
            method: "PUT",
            body: JSON.stringify({
              workspaceId: global ? undefined : workspace.id,
              config: { type: "http", url: config.url, exposure: "codemode" },
            }),
          }),
        ],
        [
          global ? `/api/settings/mcp/docs?workspaceId=${workspace.id}` : "/api/settings/mcp/docs",
          expect.objectContaining({ method: "DELETE" }),
        ],
      ]);
      expect(wrapper.find(".mcp-settings__form").exists()).toBe(false);
      wrapper.unmount();
    },
  );

  it.each([true, false])(
    "prevents moving into an existing name with Global set to %s",
    async (global) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/api/settings/mcp"))
          return json(
            settings([
              {
                name: "docs",
                scope: url.includes("workspaceId=") ? "workspace" : "global",
                config: { command: "node" },
              },
            ]),
          );
        return json(status());
      });
      const wrapper = mount(McpSettingsPanel, {
        props: { active: true, workspaceId: workspace.id },
      });
      await flushPromises();
      const card = wrapper.findAll(".mcp-settings__server")[global ? 1 : 0]!;
      await card.get('[aria-label="Edit docs"]').trigger("click");
      await card.get('[aria-label="Global server"]').setValue(global);
      await card.get(".mcp-settings__form").trigger("submit");
      await flushPromises();
      expect(wrapper.text()).toContain("already exists in that scope");
      expect(
        fetchMock.mock.calls.filter(([, init]) => ["PUT", "DELETE"].includes(init?.method ?? "")),
      ).toHaveLength(0);
      expect(card.find(".mcp-settings__form").exists()).toBe(true);
      wrapper.unmount();
    },
  );

  it("uses the selected workspace for global runtime actions and preserves OAuth polling", async () => {
    vi.useFakeTimers();
    const auth: McpAuthAttempt = {
      attemptId: "attempt-1",
      workspaceId: "workspace-1",
      serverName: "shared",
      status: "pending",
      authorizationUrl: "https://auth.example.test",
    };
    let polls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/login")) return json(auth);
      if (url.endsWith("/api/mcp/auth/attempt-1")) {
        polls++;
        return json(auth);
      }
      if (url.includes("/api/settings/mcp"))
        return json(
          settings(
            url.includes("workspaceId=")
              ? []
              : [
                  {
                    name: "shared",
                    config: { type: "http", url: "https://mcp.example.test", oauth: {} },
                    scope: "global",
                  },
                ],
          ),
        );
      if (url.includes("/api/workspaces/workspace-1/mcp/reconnect")) return json(status());
      return json(
        status([
          {
            name: "shared",
            state: "needs-auth",
            usesOAuth: true,
            hasOAuthCredentials: false,
            tools: [],
          },
        ]),
      );
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1" },
    });
    await flushPromises();
    const card = wrapper.find(".mcp-settings__server");
    await card
      .findAll("button")
      .find((button) => button.text() === "Sign in")!
      .trigger("click");
    await flushPromises();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(
      expect.arrayContaining([expect.stringContaining("/login")]),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(polls).toBe(1);
    expect(wrapper.text()).toContain("Open sign-in page");
    wrapper.unmount();
  });
});
