import { flushPromises, mount } from "@vue/test-utils";
import { expect, it, vi } from "vite-plus/test";
import McpSettingsPanel from "./McpSettingsPanel.vue";
import * as api from "@/client/lib/api";
import { reactive } from "vue";
import type { McpAuthAttempt, McpSettingsResponse, McpStatus } from "@/shared/types";

const authState = reactive({
  authAttemptsVersion: 0,
  mcpAuthAttempts: {} as Record<string, McpAuthAttempt>,
});
vi.mock("@/client/stores/app", () => ({ useAppStore: () => authState }));

vi.mock("@/client/lib/api", () => ({
  getMcpSettings: vi.fn(async () => ({ servers: [], errors: [] })),
  getMcpStatus: vi.fn(async () => ({ servers: [], errors: [] })),
  saveMcpServer: vi.fn(async () => ({ servers: [], errors: [] })),
  removeMcpServer: vi.fn(),
  reconnectMcpServer: vi.fn(),
  logoutMcpServer: vi.fn(),
  startMcpLogin: vi.fn(),
  getMcpAuthAttempt: vi.fn(),
  completeMcpAuthAttempt: vi.fn(),
  cancelMcpAuthAttempt: vi.fn(),
}));

const sharedSettings: McpSettingsResponse = {
  servers: [{ name: "shared", config: { type: "http", url: "https://mcp.example.test" } }],
  errors: [],
};

it("shows settings before slow status, then keeps known MCPs while reopening", async () => {
  const pendingStatus = Promise.withResolvers<McpStatus>();
  vi.mocked(api.getMcpSettings).mockResolvedValueOnce(sharedSettings);
  vi.mocked(api.getMcpStatus).mockReturnValueOnce(pendingStatus.promise);
  const wrapper = mount(McpSettingsPanel, { props: { active: true } });
  expect(wrapper.get('[role="status"]').text()).toContain("Loading MCPs");
  await flushPromises();
  expect(wrapper.get("article strong").text()).toBe("shared");
  expect(wrapper.text()).toContain("Loading status");
  pendingStatus.resolve({
    servers: [
      {
        name: "shared",
        state: "connected",
        tools: [],
        usesOAuth: false,
        hasOAuthCredentials: false,
      },
    ],
    errors: [],
  });
  await flushPromises();
  expect(wrapper.find('[role="status"]').exists()).toBe(false);
  await wrapper.setProps({ active: false });
  expect(wrapper.get("article strong").text()).toBe("shared");
  const refresh = Promise.withResolvers<McpSettingsResponse>();
  vi.mocked(api.getMcpSettings).mockReturnValueOnce(refresh.promise);
  await wrapper.setProps({ active: true });
  expect(wrapper.get("article strong").text()).toBe("shared");
  expect(wrapper.find('[role="status"]').exists()).toBe(true);
  refresh.resolve({ servers: [], errors: [] });
  await flushPromises();
  expect(wrapper.find("article").exists()).toBe(false);
  expect(wrapper.text()).toContain("No MCP servers configured");
  wrapper.unmount();
});

it("keeps successful settings when status fails and supports retry", async () => {
  vi.mocked(api.getMcpSettings).mockResolvedValueOnce(sharedSettings);
  vi.mocked(api.getMcpStatus).mockRejectedValueOnce(new Error("Status request failed"));
  const wrapper = mount(McpSettingsPanel, { props: { active: true } });
  await flushPromises();
  expect(wrapper.get("article strong").text()).toBe("shared");
  expect(wrapper.get('[role="alert"]').text()).toContain("Status request failed");
  expect(wrapper.text()).toContain("Status unavailable");
  vi.mocked(api.getMcpSettings).mockResolvedValueOnce(sharedSettings);
  await wrapper.get('[role="alert"] button').trigger("click");
  await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(wrapper.get("article strong").text()).toBe("shared");
  wrapper.unmount();
});

it("shows settings failures without presenting a configured-empty state", async () => {
  vi.mocked(api.getMcpSettings).mockRejectedValueOnce(new Error("Settings unavailable"));
  const wrapper = mount(McpSettingsPanel, { props: { active: true } });
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("Settings unavailable");
  expect(wrapper.text()).not.toContain("No MCP servers configured");
  expect(wrapper.find('[role="status"]').exists()).toBe(false);
  wrapper.unmount();
});

it("ignores stale results and failures after close/reopen", async () => {
  const oldSettings = Promise.withResolvers<McpSettingsResponse>();
  const oldStatus = Promise.withResolvers<McpStatus>();
  vi.mocked(api.getMcpSettings).mockReturnValueOnce(oldSettings.promise);
  vi.mocked(api.getMcpStatus).mockReturnValueOnce(oldStatus.promise);
  const wrapper = mount(McpSettingsPanel, { props: { active: true } });
  await wrapper.setProps({ active: false });
  expect(wrapper.attributes("aria-busy")).toBe("false");
  vi.mocked(api.getMcpSettings).mockResolvedValueOnce(sharedSettings);
  await wrapper.setProps({ active: true });
  await flushPromises();
  oldSettings.resolve({ servers: [], errors: [] });
  oldStatus.reject(new Error("Old failure"));
  await flushPromises();
  expect(wrapper.get("article strong").text()).toBe("shared");
  expect(wrapper.text()).not.toContain("Old failure");
  expect(wrapper.attributes("aria-busy")).toBe("false");
  wrapper.unmount();
});

async function mountOAuthServer() {
  vi.mocked(api.getMcpSettings).mockResolvedValueOnce({
    servers: [{ name: "remote", config: { type: "http", url: "https://mcp.example.test" } }],
    errors: [],
  });
  vi.mocked(api.getMcpStatus).mockResolvedValueOnce({
    servers: [
      {
        name: "remote",
        state: "needs-auth",
        tools: [],
        usesOAuth: true,
        hasOAuthCredentials: false,
      },
    ],
    errors: [],
  });
  const wrapper = mount(McpSettingsPanel, { props: { active: true } });
  await flushPromises();
  return wrapper;
}

it("applies completion delivered before the MCP start response without polling", async () => {
  const wrapper = await mountOAuthServer();
  const started = Promise.withResolvers<McpAuthAttempt>();
  vi.mocked(api.startMcpLogin).mockReturnValueOnce(started.promise);
  await wrapper.get("button:has(svg.lucide-log-in)").trigger("click");
  authState.mcpAuthAttempts.early = {
    attemptId: "early",
    serverName: "remote",
    status: "completed",
  };
  started.resolve({ attemptId: "early", serverName: "remote", status: "pending" });
  await flushPromises();
  expect(api.getMcpAuthAttempt).not.toHaveBeenCalled();
  expect(wrapper.find(".mcp-settings__auth").exists()).toBe(false);
  wrapper.unmount();
});

it("shows authoritative attempt loss after a reconnect snapshot", async () => {
  const wrapper = await mountOAuthServer();
  const pending: McpAuthAttempt = { attemptId: "lost", serverName: "remote", status: "pending" };
  authState.mcpAuthAttempts.lost = pending;
  vi.mocked(api.startMcpLogin).mockResolvedValueOnce(pending);
  await wrapper.get("button:has(svg.lucide-log-in)").trigger("click");
  await flushPromises();
  vi.mocked(api.getMcpAuthAttempt).mockRejectedValueOnce(
    Object.assign(new Error("MCP sign-in not found"), { status: 404 }),
  );
  delete authState.mcpAuthAttempts.lost;
  authState.authAttemptsVersion++;
  await flushPromises();
  expect(wrapper.text()).toContain("MCP sign-in not found");
  expect(api.getMcpAuthAttempt).toHaveBeenCalledTimes(1);
  wrapper.unmount();
});

it("keeps a successful cancellation when the event stream still has pending status", async () => {
  const wrapper = await mountOAuthServer();
  const pending: McpAuthAttempt = {
    attemptId: "cancelled",
    serverName: "remote",
    status: "pending",
  };
  authState.mcpAuthAttempts.cancelled = pending;
  vi.mocked(api.startMcpLogin).mockResolvedValueOnce(pending);
  await wrapper.get("button:has(svg.lucide-log-in)").trigger("click");
  await flushPromises();
  vi.mocked(api.cancelMcpAuthAttempt).mockResolvedValueOnce({ ...pending, status: "cancelled" });
  await wrapper.get(".mcp-settings__auth button:last-child").trigger("click");
  await flushPromises();
  expect(wrapper.text()).not.toContain("Waiting for authorization");
  const calls = vi.mocked(api.cancelMcpAuthAttempt).mock.calls.length;
  wrapper.unmount();
  expect(api.cancelMcpAuthAttempt).toHaveBeenCalledTimes(calls);
});

it("keeps manual completion errors until a new status event arrives", async () => {
  const wrapper = await mountOAuthServer();
  const pending: McpAuthAttempt = { attemptId: "manual", serverName: "remote", status: "pending" };
  authState.mcpAuthAttempts.manual = pending;
  vi.mocked(api.startMcpLogin).mockResolvedValueOnce(pending);
  await wrapper.get("button:has(svg.lucide-log-in)").trigger("click");
  await flushPromises();
  vi.mocked(api.completeMcpAuthAttempt).mockRejectedValueOnce(new Error("Invalid callback"));
  await wrapper.get(".mcp-settings__auth textarea").setValue("https://callback.test");
  await wrapper.get(".mcp-settings__auth button").trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("Invalid callback");
  authState.mcpAuthAttempts.manual = { ...pending, status: "completed" };
  await flushPromises();
  expect(wrapper.find(".mcp-settings__auth").exists()).toBe(false);
  wrapper.unmount();
});

it("adds a shared server without a workspace or scope selector", async () => {
  const wrapper = mount(McpSettingsPanel, { props: { active: true } });
  await flushPromises();
  expect(api.getMcpSettings).toHaveBeenCalledWith();
  expect(api.getMcpStatus).toHaveBeenCalledWith();
  await wrapper.get("button.mcp-settings__add").trigger("click");
  expect(wrapper.find('input[aria-label="Global server"]').exists()).toBe(false);
  expect(wrapper.find('[role="switch"]').exists()).toBe(false);
  await wrapper.get('input[aria-label="MCP server name"]').setValue("shared");
  await wrapper
    .get('textarea[aria-label="MCP server configuration"]')
    .setValue('{"command":"server"}');
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(api.saveMcpServer).toHaveBeenCalledWith("shared", {
    command: "server",
    exposure: "codemode",
  });
  wrapper.unmount();
});
