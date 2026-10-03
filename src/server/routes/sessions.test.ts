import { describe, expect, it, vi } from "vite-plus/test";
import { parseClientMessageId, registerSessionRoutes } from "./sessions";

describe("session routes", () => {
  it("forwards the captured native history boundary to message paging", async () => {
    const app = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
    const page = { historyVersion: 12, messages: [], totalMessageCount: 0, hasMoreMessages: false };
    const getSessionMessages = vi.fn(() => page);
    registerSessionRoutes({
      app,
      config: {},
      service: { hasSession: () => true, getSessionMessages },
      routePath: (path: string) => path,
    } as never);
    const handler = app.get.mock.calls.find(
      ([route]) => route === "/api/sessions/:sessionId/messages",
    )![1];
    await expect(
      handler({
        params: { sessionId: "session" },
        query: {
          throughEntryId: "12",
          limit: "3",
          before: "user-10-2",
        },
      }),
    ).resolves.toEqual(page);
    expect(getSessionMessages).toHaveBeenCalledWith("session", {
      throughEntryId: 12,
      limit: 3,
      beforeMessageId: "user-10-2",
    });
    await expect(
      handler({ params: { sessionId: "session" }, query: { throughEntryId: "bad" } }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("returns resources for the requested session", async () => {
    const app = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
    const resources = {
      skills: [{ name: "notes", description: "Manage notes", filePath: "/skills/notes/SKILL.md" }],
      tools: [{ name: "read", description: "Read files" }],
    };
    const getSessionResources = vi.fn(() => resources);
    registerSessionRoutes({
      app,
      config: {},
      service: { getSessionResources },
      routePath: (path: string) => path,
    } as never);
    const handler = app.get.mock.calls.find(
      ([route]) => route === "/api/sessions/:sessionId/resources",
    )![1];

    await expect(handler({ params: { sessionId: "session-1" } })).resolves.toEqual(resources);
    expect(getSessionResources).toHaveBeenCalledWith("session-1");
  });

  it("returns the submission-specific queue acknowledgment", async () => {
    const app = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
    const clientMessageId = crypto.randomUUID();
    const receipt = { disposition: "queued", entryId: "entry-1", clientMessageId };
    const prompt = vi.fn(async () => receipt);
    registerSessionRoutes({
      app,
      config: {},
      service: { prompt },
      routePath: (path: string) => path,
    } as never);
    const handler = app.post.mock.calls.find(
      ([route]) => route === "/api/sessions/:sessionId/prompt",
    )![1];
    async function* parts() {
      yield { type: "field", fieldname: "text", value: "next" };
      yield { type: "field", fieldname: "clientMessageId", value: clientMessageId };
      yield { type: "field", fieldname: "streamingBehavior", value: "followUp" };
    }
    expect(await handler({ params: { sessionId: "session-1" }, parts })).toEqual(receipt);
    expect(prompt).toHaveBeenCalledWith("session-1", "next", [], clientMessageId, "followUp");
  });

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
