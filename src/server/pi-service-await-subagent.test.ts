import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { PiService } from "./pi-service";
import { SessionStore } from "./session-store";
import type { WorkspaceInfo } from "@/shared/types";

const workspace = { id: "test", path: "/tmp/test" } as WorkspaceInfo;

function fixture(
  options: { owner?: string; async?: boolean; streaming?: boolean; pending?: boolean } = {},
) {
  const service = Object.create(PiService.prototype) as any;
  const requestTurnEnd = vi.fn();
  const parent = { session: { requestTurnEnd } };
  service.config = { battyDir: "/tmp/batty" };
  service.sessions = new Map([["parent", parent]]);
  service.liveSessions = new Map<string, unknown>([
    ["parent", parent],
    ["child", { session: { isStreaming: options.streaming ?? true } }],
  ]);
  service.subagentOperationAsync = new Map();
  service.subagentOperations = new Map(
    options.pending ? [["child", new Promise<void>(() => {})]] : [],
  );
  service.runDetachedSubagentSession = vi.fn();
  vi.spyOn(SessionStore, "existing").mockResolvedValue({
    appendCustomEntry: vi.fn(async () => "queue-entry"),
    getSessionFile: () => "/tmp/child.jsonl",
    getEntries: () => [
      {
        type: "custom",
        customType: "batty-subagent-session",
        data: {
          parentSessionId: options.owner ?? "parent",
          depth: 1,
          deliveryMode: options.async === false ? undefined : "prompt",
        },
      },
    ],
  } as any);
  return { service, requestTurnEnd };
}

afterEach(() => vi.restoreAllMocks());

describe("PiService.awaitSubagent", () => {
  it("ends the parent turn for a running async child", async () => {
    const { service, requestTurnEnd } = fixture();
    expect(await service.awaitSubagent(workspace, "parent", "child")).toMatchObject({
      waiting: true,
    });
    expect(requestTurnEnd).toHaveBeenCalledOnce();
  });

  it("does not end the parent turn if the child has already finished", async () => {
    const { service, requestTurnEnd } = fixture({ streaming: false });
    expect(await service.awaitSubagent(workspace, "parent", "child")).toMatchObject({
      waiting: false,
      details: {
        subagent: { workspaceId: "test", sessionId: "child", sessionPath: "/tmp/child.jsonl" },
      },
    });
    expect(requestTurnEnd).not.toHaveBeenCalled();
  });

  it("rechecks completion after async session lookup", async () => {
    const { service, requestTurnEnd } = fixture();
    const lookup = SessionStore.existing(workspace.path, "/tmp/batty", "child");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(SessionStore.existing).mockImplementation(async () => {
      await gate;
      return lookup;
    });
    const waiting = service.awaitSubagent(workspace, "parent", "child");
    service.liveSessions.get("child").session.isStreaming = false;
    release();
    expect(await waiting).toMatchObject({ waiting: false });
    expect(requestTurnEnd).not.toHaveBeenCalled();
  });

  it("yields while a completed child's reply is still awaiting admission", async () => {
    const { service, requestTurnEnd } = fixture({ streaming: false, pending: true });
    expect(await service.awaitSubagent(workspace, "parent", "child")).toMatchObject({
      waiting: true,
    });
    expect(requestTurnEnd).toHaveBeenCalledOnce();
  });

  it.each([
    { owner: "other", error: "does not belong" },
    { async: false, error: "Only async subagents" },
  ])("rejects invalid children: $error", async ({ error, ...options }) => {
    const { service, requestTurnEnd } = fixture(options);
    await expect(service.awaitSubagent(workspace, "parent", "child")).rejects.toThrow(error);
    expect(requestTurnEnd).not.toHaveBeenCalled();
  });

  it("rejects a missing child", async () => {
    const { service, requestTurnEnd } = fixture();
    vi.mocked(SessionStore.existing).mockResolvedValue(undefined);
    await expect(service.awaitSubagent(workspace, "parent", "child")).rejects.toThrow("not found");
    expect(requestTurnEnd).not.toHaveBeenCalled();
  });
});

describe("PiService.continueSubagent", () => {
  it("does not acknowledge a queued request before its durable definition commits", async () => {
    const { service } = fixture();
    service.liveSessions.get("parent").session.model = { provider: "faux", id: "test" };
    let releasePrevious!: () => void;
    service.subagentOperations.set(
      "child",
      new Promise<void>((resolve) => {
        releasePrevious = resolve;
      }),
    );
    let committed!: () => void;
    const commit = new Promise<string>((resolve) => {
      committed = () => resolve("queue-entry");
    });
    const manager = (await SessionStore.existing(workspace.path, "/tmp/batty", "child"))!;
    vi.mocked(manager.appendCustomEntry).mockReturnValue(commit);
    let acknowledged = false;
    const queued = service
      .continueSubagent(workspace, "parent", "child", "Next", true, true)
      .then((result: unknown) => {
        acknowledged = true;
        return result;
      });
    await vi.waitFor(() => expect(manager.appendCustomEntry).toHaveBeenCalledOnce());
    expect(acknowledged).toBe(false);
    committed();
    expect(await queued).toMatchObject({ text: expect.stringContaining("Subagent queued.") });
    service.closing = Promise.resolve();
    releasePrevious();
    await vi.waitFor(() => expect(service.subagentOperations.has("child")).toBe(false));
    expect(service.runDetachedSubagentSession).not.toHaveBeenCalled();
  });

  it.each([
    { streaming: true, pending: false },
    { streaming: false, pending: true },
  ])("rejects resume for an active operation: %j", async (options) => {
    const { service } = fixture(options);
    service.liveSessions.get("parent").session.model = { provider: "faux", id: "test" };
    await expect(
      service.continueSubagent(workspace, "parent", "child", "rush", true, false),
    ).rejects.toThrow("Subagent is still running");
    expect(service.runDetachedSubagentSession).not.toHaveBeenCalled();
  });

  it("keeps queue available for a running async child", async () => {
    const { service } = fixture();
    service.liveSessions.get("parent").session.model = { provider: "faux", id: "test" };
    let release!: () => void;
    service.subagentOperations.set(
      "child",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    service.runDetachedSubagentSession.mockImplementation(async (request: any) => {
      request.onReady({ subagent: { sessionId: "child" } });
      return { text: "done", details: {}, isError: false };
    });
    await expect(
      service.continueSubagent(workspace, "parent", "child", "next", true, true),
    ).resolves.toMatchObject({
      text: expect.stringContaining("Subagent queued."),
      details: {
        subagent: { workspaceId: "test", sessionId: "child", sessionPath: "/tmp/child.jsonl" },
      },
    });
    const manager = await SessionStore.existing(workspace.path, "/tmp/batty", "child");
    expect(manager!.appendCustomEntry).toHaveBeenCalledWith(
      "batty-subagent-queue",
      expect.objectContaining({
        operationId: expect.any(String),
        options: expect.objectContaining({
          prompt: "next",
          continueSession: true,
          operationId: expect.any(String),
        }),
      }),
    );
    expect(service.runDetachedSubagentSession).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(service.runDetachedSubagentSession).toHaveBeenCalledOnce());
  });

  it.each([true, false])("resumes a finished child (async=%s)", async (async) => {
    const { service } = fixture({ streaming: false });
    service.liveSessions.get("parent").session.model = { provider: "faux", id: "test" };
    service.runDetachedSubagentSession.mockImplementation(async (request: any) => {
      request.onReady({ subagent: { sessionId: "child" } });
      return { text: "done", details: {}, isError: false };
    });
    await expect(
      service.continueSubagent(workspace, "parent", "child", "next", async, false),
    ).resolves.toMatchObject({ isError: false });
    expect(service.runDetachedSubagentSession).toHaveBeenCalledOnce();
  });
});
