import { afterEach, expect, test, vi } from "vite-plus/test";
import { searchWorkspaceFiles } from "./api";
import { rpcCall } from "./rpc";
vi.mock("./rpc", () => ({ rpcCall: vi.fn(), closeRpcTransport: vi.fn() }));
afterEach(() => vi.resetAllMocks());
function events(items: object[]) {
  return new ReadableStream({
    start(controller) {
      for (const item of items) controller.enqueue(item);
      controller.close();
    },
  });
}
test("streams native filename matches, including Unicode, with cancellable search input", async () => {
  vi.mocked(rpcCall).mockResolvedValue({
    value: undefined,
    events: events([
      { kind: "match", path: "nested/Ångström.ts" },
      { kind: "match", path: "another/Ångström.ts" },
      { kind: "done" },
    ]),
  });
  const controller = new AbortController();
  const matches: string[] = [];
  await searchWorkspaceFiles("project", "ångström", controller.signal, (paths) =>
    matches.push(...paths),
  );
  expect(matches).toEqual(["nested/Ångström.ts", "another/Ångström.ts"]);
  expect(rpcCall).toHaveBeenCalledWith(
    "workspace.search",
    { workspaceId: "project", name: "ångström" },
    { signal: controller.signal },
  );
});
test("keeps partial matches but surfaces scan failures and truncated subscriptions", async () => {
  for (const tail of [{ kind: "error", message: "Permission denied" }, undefined]) {
    vi.mocked(rpcCall).mockResolvedValue({
      value: undefined,
      events: events([{ kind: "match", path: "found.ts" }, ...(tail ? [tail] : [])]),
    });
    const matches: string[] = [];
    await expect(
      searchWorkspaceFiles("project", "found", new AbortController().signal, (paths) =>
        matches.push(...paths),
      ),
    ).rejects.toThrow(
      tail ? "Search incomplete: Permission denied" : "File search ended before completion",
    );
    expect(matches).toEqual(["found.ts"]);
  }
});
