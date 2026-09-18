import { describe, expect, it, vi } from "vite-plus/test";
import { parseClientMessageId, registerSessionRoutes } from "./sessions";

describe("session routes", () => {
  it("lists running subagents for the requested parent session", async () => {
    const app = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
    const listRunningSubagents = vi.fn(() => [{ sessionId: "child-1" }]);
    registerSessionRoutes({
      app,
      config: {},
      service: { listRunningSubagents },
      routePath: (path: string) => path,
    } as never);

    const registration = app.get.mock.calls.find(
      ([path]) => path === "/api/sessions/:sessionId/subagents",
    );
    const handler = registration?.[1] as (request: {
      params: { sessionId: string };
    }) => Promise<unknown>;

    await expect(handler({ params: { sessionId: "parent-1" } })).resolves.toEqual([
      { sessionId: "child-1" },
    ]);
    expect(listRunningSubagents).toHaveBeenCalledWith("parent-1");
  });
});

describe("parseClientMessageId", () => {
  it("accepts UUID client message IDs", () => {
    const id = crypto.randomUUID();
    expect(parseClientMessageId(id)).toBe(id);
  });

  it.each([undefined, "", "not-a-uuid"])("rejects invalid client message ID %s", (value) => {
    expect(() => parseClientMessageId(value)).toThrow("A valid clientMessageId is required");
  });
});
