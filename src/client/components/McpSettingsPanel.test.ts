import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import McpSettingsPanel from "./McpSettingsPanel.vue";
import type {
  McpAuthAttempt,
  McpSettingsResponse,
  McpWorkspaceStatus,
  WorkspaceInfo,
} from "@/shared/types";

const workspaces: WorkspaceInfo[] = [
  {
    id: "workspace-1",
    label: "Project One",
    path: "/project-one",
    kind: "workspace",
    isPinned: false,
    isAssistant: false,
  },
  {
    id: "workspace-2",
    label: "Project Two",
    path: "/project-two",
    kind: "workspace",
    isPinned: false,
    isAssistant: false,
  },
];
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

const workspace = workspaces[0]!;

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
    const toolButtons = wrapper.findAll('[aria-label="Show tools for docs"]');
    expect(toolButtons).toHaveLength(2);
    const targets = toolButtons.map((button) => button.attributes("popovertarget"));
    expect(new Set(targets).size).toBe(2);
    for (const [index, card] of wrapper.findAll(".mcp-settings__server").entries()) {
      expect(toolButtons[index]!.text()).toBe("Tools (1)");
      const popover = card.get('[popover="auto"]');
      expect(popover.attributes("id")).toBe(targets[index]);
      expect(popover.get(".mcp-settings__tools").text()).toContain("Search docs");
      expect(card.find(".mcp-settings__server-head .mcp-settings__tools").exists()).toBe(false);
    }
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
      .find((button) => button.text() === "Cancel")!
      .trigger("click");
    for (const action of ["Reconnect", "Sign in", "Sign out"]) {
      expect(
        wrapper
          .findAll("button")
          .find((button) => button.text() === action)
          ?.attributes("disabled"),
      ).toBeDefined();
    }
    expect(wrapper.text()).toContain("Workspace · Project One");
    await wrapper.findAll(".mcp-settings__server")[1]!.get("button").trigger("click");
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

    await wrapper.findAll('[aria-label="Remove docs"]')[0]!.trigger("click");
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
    await wrapper.setProps({ workspaceId: "workspace-2", workspaces: [workspaces[1]!] });
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
      .find((button) => button.text() === "Disable")!
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
      return json(status([{ name: "shared", scope: "project", state: "connected", tools: [] }]));
    });
    window.confirm = vi.fn(() => true);
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1", workspaces },
    });
    await flushPromises();
    await wrapper
      .findAll(".mcp-settings__server")[0]!
      .findAll("button")
      .find((button) => button.text() === "Disable")!
      .trigger("click");
    await flushPromises();
    await wrapper
      .findAll(".mcp-settings__server")[0]!
      .get('[aria-label="Remove shared"]')
      .trigger("click");
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
    expect(wrapper.findAll(".mcp-settings__server")[1]!.text()).toContain(
      "Workspace · Project One",
    );
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
            url.includes("workspaceId=workspace-2")
              ? [{ name: "other", scope: "workspace", config: { type: "stdio", command: "node" } }]
              : [],
          ),
        );
      return json(status([{ name: "other", state: "connected", tools: [] }]));
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1", workspaces },
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Reconnect")!
      .trigger("click");
    await wrapper.setProps({ workspaceId: "workspace-2" });
    await flushPromises();
    release(
      json(status([{ name: "other", state: "stale", error: "Stale runtime error", tools: [] }])),
    );
    await flushPromises();
    expect(wrapper.text()).toContain("connected");
    expect(wrapper.text()).not.toContain("Stale runtime error");
    wrapper.unmount();
  });

  it("retains explicitly requested other-workspace status and invalidates it on configuration edits", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "PUT") return json(settings());
      if (url.endsWith("/reconnect"))
        return json(
          status([
            {
              name: "other",
              state: "connected",
              tools: [{ name: "search", exposure: "codemode" }],
            },
          ]),
        );
      if (url.endsWith("/logout"))
        return json({
          servers: [{ name: "other", state: "auth_required", error: "Sign in again", tools: [] }],
          errors: ["Workspace runtime error"],
        });
      if (url.includes("/api/settings/mcp"))
        return json(
          settings(
            url.includes("workspaceId=workspace-2")
              ? [
                  {
                    name: "other",
                    scope: "workspace",
                    config: { type: "http", url: "https://old.example" },
                  },
                ]
              : [],
          ),
        );
      return json(status());
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1", workspaces },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("Not inspected");
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/workspaces/")),
    ).toHaveLength(1);
    const action = async (name: string) => {
      await wrapper
        .findAll(".mcp-settings__server button")
        .find((button) => button.text() === name)!
        .trigger("click");
      await flushPromises();
    };
    await action("Reconnect");
    expect(wrapper.text()).toContain("connected");
    expect(wrapper.text()).toContain("search");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace-2/mcp/other/reconnect",
      expect.anything(),
    );
    await action("Sign out");
    expect(wrapper.text()).toContain("Sign in again");
    expect(wrapper.text()).toContain("Workspace runtime error");
    expect(wrapper.text()).not.toContain("search");
    await action("Reconnect");
    await action("Edit");
    await wrapper
      .get('[aria-label="MCP server configuration"]')
      .setValue('{"type":"http","url":"https://new.example"}');
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("Not inspected");
    expect(wrapper.text()).not.toContain("search");
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === "/api/workspaces/workspace-2/mcp"),
    ).toHaveLength(0);
    wrapper.unmount();
  });

  it("clears a deleted creation workspace and refuses to submit an obsolete target", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        json(String(input).includes("/api/settings/mcp") ? settings() : status()),
      );
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1", workspaces },
    });
    await flushPromises();
    await wrapper.get("button").trigger("click");
    await wrapper.get('[aria-label="Global server"]').setValue(false);
    await wrapper.get('[aria-label="Server workspace"]').setValue("workspace-2");
    await wrapper.get('[aria-label="MCP server name"]').setValue("draft");
    await wrapper
      .get('[aria-label="MCP server configuration"]')
      .setValue('{"type":"stdio","command":"node"}');
    await wrapper.setProps({ workspaces: [workspace] });
    await flushPromises();
    expect(wrapper.get('[aria-label="Server workspace"]').element).toHaveProperty("value", "");
    expect(wrapper.get('button[type="submit"]').attributes("disabled")).toBeDefined();
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    expect(wrapper.text()).toContain("Choose a workspace");
    wrapper.unmount();
  });

  it("refreshes other-workspace status after OAuth completion without probing every workspace", async () => {
    const auth: McpAuthAttempt = {
      attemptId: "other-auth",
      workspaceId: "workspace-2",
      serverName: "other",
      status: "pending",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/login")) return json(auth);
      if (url.endsWith("/api/mcp/auth/other-auth") && init?.method === "POST")
        return json({ ...auth, status: "completed" });
      if (url.includes("/api/settings/mcp"))
        return json(
          settings(
            url.includes("workspaceId=workspace-2")
              ? [
                  {
                    name: "other",
                    scope: "workspace",
                    config: { type: "http", url: "https://mcp.example", oauth: {} },
                  },
                ]
              : [],
          ),
        );
      if (url === "/api/workspaces/workspace-2/mcp")
        return json(
          status([
            {
              name: "other",
              state: "connected",
              tools: [{ name: "calendar", exposure: "codemode" }],
            },
          ]),
        );
      return json(status());
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1", workspaces },
    });
    await flushPromises();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === "/api/workspaces/workspace-2/mcp"),
    ).toBe(false);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Sign in")!
      .trigger("click");
    await flushPromises();
    await wrapper
      .get('[aria-label="MCP OAuth callback URL"]')
      .setValue("http://localhost/callback?code=abc");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Complete sign-in")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("calendar");
    expect(wrapper.text()).toContain("connected");
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === "/api/workspaces/workspace-2/mcp"),
    ).toHaveLength(1);
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
        status([{ name: "shared", scope: "project", state: "auth_required", tools: [] }]),
      );
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1", workspaces },
    });
    await flushPromises();
    const cards = wrapper.findAll(".mcp-settings__server");
    expect(
      cards[0]!
        .findAll("button")
        .find((button) => button.text() === "Sign in")!
        .attributes("disabled"),
    ).toBeDefined();
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

  it("loads global and every workspace server, presents globals first and labels each workspace", async () => {
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
      props: { active: true, workspaceId: "workspace-1", workspaces },
    });
    await flushPromises();
    const names = wrapper.findAll(".mcp-settings__server-meta strong").map((item) => item.text());
    expect(names).toEqual(["global", "zeta", "alpha"]);
    expect(wrapper.text()).toContain("Workspace · Project One");
    expect(wrapper.text()).toContain("Workspace · Project Two");
    expect(wrapper.findAll('[aria-label^="Show tools for"]')).toHaveLength(0);
    expect(wrapper.findAll("[popover]")).toHaveLength(0);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("workspaceId=workspace-1")),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("workspaceId=workspace-2")),
    ).toBe(true);
    expect(wrapper.text()).not.toContain("Refresh servers");
    wrapper.unmount();
  });

  it("keeps creation collapsed initially and conditionally offers workspace selection with the exact POST target", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (init?.method === "PUT") return json(settings());
      if (String(input).includes("/api/settings/mcp")) return json(settings());
      return json(status());
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1", workspaces },
    });
    await flushPromises();
    expect(wrapper.find('[aria-label="MCP server name"]').exists()).toBe(false);
    await wrapper.get("button").trigger("click");
    expect(wrapper.get('[aria-label="Global server"]').element).toHaveProperty("checked", true);
    const saveButton = wrapper.get('button[type="submit"]');
    expect(saveButton.classes()).toContain("settings-popover__action--primary");
    expect(saveButton.find("svg").exists()).toBe(true);
    const scopeRow = wrapper.get(".mcp-settings__scope-row");
    expect(scopeRow.get('[role="switch"]').attributes("aria-label")).toBe("Global server");
    expect(scopeRow.get(".mcp-settings__switch-track").attributes("aria-hidden")).toBe("true");
    expect(scopeRow.get("label").text()).toBe("Global server");
    expect(wrapper.findAll('[aria-label="Server workspace"]')).toHaveLength(0);
    await wrapper.get('[aria-label="Global server"]').setValue(false);
    expect(scopeRow.findAll('[aria-label="Server workspace"]')).toHaveLength(1);
    await wrapper.get('[aria-label="Server workspace"]').setValue("workspace-2");
    await wrapper.get('[aria-label="MCP server name"]').setValue("new-project-server");
    await wrapper
      .get('[aria-label="MCP server configuration"]')
      .setValue('{"type":"stdio","command":"node"}');
    await wrapper.get(".mcp-settings__form").trigger("submit");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/mcp/new-project-server"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          workspaceId: "workspace-2",
          config: { type: "stdio", command: "node" },
        }),
      }),
    );
    expect(wrapper.find('[aria-label="MCP server name"]').exists()).toBe(false);
    await wrapper.get("button").trigger("click");
    await wrapper.get('[aria-label="Global server"]').setValue(false);
    await wrapper.get('[aria-label="Server workspace"]').setValue("workspace-2");
    await wrapper.get('[aria-label="Global server"]').setValue(true);
    expect(wrapper.find('[aria-label="Server workspace"]').exists()).toBe(false);
    await wrapper.get('[aria-label="Global server"]').setValue(false);
    expect(wrapper.get('[aria-label="Server workspace"]').element).toHaveProperty(
      "value",
      "workspace-2",
    );
    wrapper.unmount();
  });

  it("edits and removes a server in its own workspace even when another workspace is selected", async () => {
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
    window.confirm = vi.fn(() => true);
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1", workspaces },
    });
    await flushPromises();
    const two = wrapper
      .findAll(".mcp-settings__server")
      .find((card) => card.text().includes("Workspace · Project Two"))!;
    await two.get("button").trigger("click");
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
    const updatedCard = wrapper
      .findAll(".mcp-settings__server")
      .find((card) => card.text().includes("Workspace · Project Two"))!;
    await updatedCard.get('[aria-label="Remove two"]').trigger("click");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/mcp/two?workspaceId=workspace-2"),
      expect.objectContaining({ method: "DELETE" }),
    );
    wrapper.unmount();
  });

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
      return json(status([{ name: "shared", state: "connected", tools: [] }]));
    });
    const wrapper = mount(McpSettingsPanel, {
      props: { active: true, workspaceId: "workspace-1", workspaces },
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
