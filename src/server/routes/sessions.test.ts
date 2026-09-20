import { describe, expect, it, vi } from "vite-plus/test";
import { parseClientMessageId, registerSessionRoutes } from "./sessions";

describe("session routes", () => {
  it("serves session-owned images", async () => {
    const app = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
    const resolveSessionImage = vi.fn(async () => ({
      path: import.meta.filename,
      mimeType: "image/png",
    }));
    registerSessionRoutes({
      app,
      config: {},
      service: { resolveSessionImage },
      routePath: (path: string) => path,
    } as never);
    const registration = app.get.mock.calls.find(
      ([route]) => route === "/api/session-images/:workspaceId/:sessionId/:name",
    );
    const handler = registration?.[1] as (request: unknown, reply: unknown) => Promise<unknown>;
    const header = vi.fn();
    const send = vi.fn((stream: { destroy(): void }) => {
      stream.destroy();
      return "sent";
    });

    await expect(
      handler(
        {
          params: { workspaceId: "workspace-1", sessionId: "session-1", name: "image.png" },
        },
        { header, send },
      ),
    ).resolves.toBe("sent");
    expect(resolveSessionImage).toHaveBeenCalledWith("workspace-1", "session-1", "image.png");
    expect(header).toHaveBeenCalledWith("Content-Type", "image/png");
  });

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
