import { flushPromises, mount } from "@vue/test-utils";
import { expect, it, vi } from "vite-plus/test";
import McpSettingsPanel from "./McpSettingsPanel.vue";
import * as api from "@/client/lib/api";
import { reactive } from "vue";
import type { McpAuthAttempt } from "@/shared/types";

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

it("keeps a successful cancellation when SSE still has pending status", async () => {
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

it("keeps manual completion errors until a new SSE status arrives", async () => {
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
