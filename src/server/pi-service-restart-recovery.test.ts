import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceInfo } from "@/shared/types";
import { PiService } from "./pi-service";
import { prepareInteractiveTurnRecovery, resumeInteractiveTurn } from "./interactive-turn-recovery";
import { externalizeInlineImagesInSession } from "./pi-service-uploads";

vi.mock("./interactive-turn-recovery", () => ({
  prepareInteractiveTurnRecovery: vi.fn(),
  resumeInteractiveTurn: vi.fn(),
}));

vi.mock("./pi-service-uploads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pi-service-uploads")>()),
  externalizeInlineImagesInSession: vi.fn(),
}));

vi.mock("./workspaces", () => ({
  listWorkspaces: vi.fn(async () => [
    {
      id: "batty",
      label: "Batty",
      path: "/workspace",
      kind: "workspace",
      isPinned: true,
      isAssistant: false,
    },
  ]),
  resolveWorkspace: vi.fn((workspaces, workspaceId) =>
    workspaces.find((workspace: { id: string }) => workspace.id === workspaceId),
  ),
}));

const workspace: WorkspaceInfo = {
  id: "batty",
  label: "Batty",
  path: "/workspace",
  kind: "workspace",
  isPinned: true,
  isAssistant: false,
};

function createService(
  journal: any = {
    list: vi.fn(() => []),
    set: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
  },
) {
  const service: any = Object.create(PiService.prototype);
  service.config = { uploadsDir: "/uploads", baseUrl: "/batty" };
  service.activeInteractiveTurns = journal;
  service.subagentQueues = new Map();
  service.sessions = new Map();
  service.publish = vi.fn();
  service.getStateMetadata = vi.fn(() => ({}));
  service.getState = vi.fn(() => ({}));
  return { service, journal };
}

function createWebSession(): any {
  return {
    id: "session-1",
    workspace,
    session: {
      sessionId: "session-1",
      sessionFile: "/sessions/session-1.jsonl",
      sessionManager: { getBranch: vi.fn(() => []) },
      isStreaming: false,
    },
    activeTools: new Map(),
    subscribers: new Set(),
    revision: 0,
    eventLog: [],
    agentCompleted: false,
    suppressNextAgentEndCompletion: false,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("PiService interactive-turn restart recovery", () => {
  it("writes the active-turn marker only when Pi reports that a turn started", async () => {
    const { service, journal } = createService();
    const webSession = createWebSession();
    let options: { onTurnStarted?: () => Promise<void> } | undefined;
    webSession.session.prompt = vi.fn(async (_text: string, promptOptions: typeof options) => {
      options = promptOptions;
    });
    service.requireSession = vi.fn(() => webSession);

    await service.prompt("session-1", "hello", [], "message-1");

    expect(journal.set).not.toHaveBeenCalled();
    await options?.onTurnStarted?.();
    expect(journal.set).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      sessionId: "session-1",
      sessionPath: "/sessions/session-1.jsonl",
    });
  });

  it("clears a stale marker when the persisted turn already completed", async () => {
    const { service, journal } = createService({
      list: vi.fn(() => [
        {
          workspaceId: workspace.id,
          sessionId: "session-1",
          sessionPath: "/sessions/session-1.jsonl",
        },
      ]),
      set: vi.fn(),
      deleteSession: vi.fn(async () => undefined),
    });
    const webSession = createWebSession();
    service.openSession = vi.fn(async () => ({ sessionId: "session-1" }));
    service.requireSession = vi.fn(() => webSession);
    vi.mocked(prepareInteractiveTurnRecovery).mockReturnValue({ action: "complete" });

    await service.recoverActiveInteractiveTurns();

    expect(journal.deleteSession).toHaveBeenCalledWith("session-1");
    expect(resumeInteractiveTurn).not.toHaveBeenCalled();
  });

  it("resumes an interrupted turn, externalizes its images, and accepts a steering prompt while it runs", async () => {
    const { service } = createService({
      list: vi.fn(() => [
        {
          workspaceId: workspace.id,
          sessionId: "session-1",
          sessionPath: "/sessions/session-1.jsonl",
        },
      ]),
      set: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    });
    const webSession = createWebSession();
    const recovery = Promise.withResolvers<void>();
    webSession.session.prompt = vi.fn(async () => undefined);
    service.openSession = vi.fn(async () => ({ sessionId: "session-1" }));
    service.requireSession = vi.fn(() => webSession);
    vi.mocked(prepareInteractiveTurnRecovery).mockReturnValue({
      action: "resume",
      toolResults: [],
    });
    vi.mocked(resumeInteractiveTurn).mockReturnValue(recovery.promise);

    await service.recoverActiveInteractiveTurns();
    await service.prompt("session-1", "steer this", [], "message-2", "steer");

    expect(webSession.session.prompt).toHaveBeenCalledWith(
      "steer this",
      expect.objectContaining({ streamingBehavior: "steer" }),
    );
    recovery.resolve();
    await vi.waitFor(() => {
      expect(externalizeInlineImagesInSession).toHaveBeenCalledWith(
        webSession.session,
        "/uploads",
        "/batty",
      );
    });
  });

  it("removes the marker on abort and when a failed recovery settles without retrying it", async () => {
    const { service, journal } = createService({
      list: vi.fn(() => [
        {
          workspaceId: workspace.id,
          sessionId: "session-1",
          sessionPath: "/sessions/session-1.jsonl",
        },
      ]),
      set: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    });
    const webSession = createWebSession();
    webSession.session.abort = vi.fn(async () => undefined);
    service.openSession = vi.fn(async () => ({ sessionId: "session-1" }));
    service.requireSession = vi.fn(() => webSession);
    vi.mocked(prepareInteractiveTurnRecovery).mockReturnValue({
      action: "resume",
      toolResults: [],
    });
    vi.mocked(resumeInteractiveTurn).mockRejectedValue(new Error("recovery failed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await service.recoverActiveInteractiveTurns();
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
    await service.handleAgentEvent(webSession, { type: "agent_settled" });
    await service.abort("session-1");

    expect(resumeInteractiveTurn).toHaveBeenCalledTimes(1);
    expect(journal.deleteSession).toHaveBeenCalledTimes(2);
    expect(journal.deleteSession).toHaveBeenNthCalledWith(1, "session-1");
    expect(journal.deleteSession).toHaveBeenNthCalledWith(2, "session-1");
  });
});
