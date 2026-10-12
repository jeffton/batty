// @vitest-environment node
import { expect, it, vi } from "vite-plus/test";
import { McpService } from "./mcp-service";

for (const action of ["cancel", "dispose"] as const) {
  it(`aborts MCP OAuth discovery on ${action} before a redirect prompt exists`, async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const closed = vi.fn();
    const reconnected = vi.fn();
    const connection = {
      name: "remote",
      oauthUrl: "https://mcp.example.test",
      oauthSettings: () => ({}),
      reconnect: reconnected,
      close: closed,
    };
    const modules = {
      auth: {
        McpOAuthCredentialStore: class {
          forServer() {
            return {};
          }
        },
        signInMcpServer: ({ signal }: { signal: AbortSignal }) =>
          new Promise<void>((_resolve, reject) => {
            started.resolve(signal);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      },
      backend: { FileAuthStorageBackend: class {} },
    };
    const service: McpService = new (McpService as any)({ battyDir: "/tmp" }, modules);
    (service as any).session = Promise.resolve([connection]);
    const attempt = service.startAuth("remote");
    const signal = await started.promise;
    expect(signal.aborted).toBe(false);
    try {
      if (action === "cancel") await service.cancelAuth(attempt.attemptId);
      else await service.dispose();
      expect(signal.aborted).toBe(true);
      expect(service.getAuthAttempt(attempt.attemptId).status).toBe("cancelled");
      expect(reconnected).not.toHaveBeenCalled();
    } finally {
      await service.dispose();
    }
    expect(closed).toHaveBeenCalledTimes(1);
  });
}
