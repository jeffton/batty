// @vitest-environment node
import { expect, it, vi } from "vite-plus/test";
import { createOwnerRpcHandler, type OwnerRpcServices } from "./owner-rpc";
import type { Runtime } from "./runtime";

it("native MCP operations reject scoped mutations and preserve global settings", async () => {
  const mcp = {
    readSettings: vi.fn(() => ({ servers: [], errors: [] })),
    getStatus: vi.fn(() => ({ servers: [], errors: [] })),
    setServer: vi.fn(() => ({})),
    removeServer: vi.fn(() => ({})),
    reconnect: vi.fn((name: string) => ({ name })),
  };
  const handler = createOwnerRpcHandler(
    { config: {}, tools: { mcp } } as unknown as Runtime,
    {} as OwnerRpcServices,
  );
  const call = async (name: string, input: object = {}) =>
    (await handler(name, input, { signal: new AbortController().signal })).value;
  expect(await call("mcp.status")).toEqual({ servers: [], errors: [] });
  for (const workspaceId of ["one", "two"]) {
    await expect(call("mcp.settings", { workspaceId })).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
    await expect(
      call("mcp.set", { name: "test", config: { command: "test" }, workspaceId }),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(call("mcp.remove", { name: "test", workspaceId })).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
  }
  expect(mcp.setServer).not.toHaveBeenCalled();
  expect(mcp.removeServer).not.toHaveBeenCalled();
  await call("mcp.set", { name: "test", config: { command: "test" } });
  expect(mcp.setServer).toHaveBeenCalledWith("test", { command: "test" });
  expect(await call("mcp.reconnect", { name: "test" })).toEqual({ name: "test" });
});
