import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context, getOrThrow } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "./config";
import type { CronService } from "./cron";
import { createPiAgentSession } from "./pi-agent-session";
import { HarnessSessionStore } from "./harness-session-store";
import { PiService } from "./pi-service";
import { workspaceSessionDir } from "./pi-paths";
import type { WorkspaceInfo } from "@/shared/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks();
});

async function createService() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-service-drain-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  vi.spyOn(ModelRuntime, "create").mockResolvedValue(models as unknown as ModelRuntime);
  const config = {
    battyDir: path.join(root, "data"),
    selfPath: root,
    workspacesRoots: [path.join(root, "workspaces")],
    uploadsDir: path.join(root, "uploads"),
    baseUrl: "http://localhost",
    defaultProvider: "faux",
    defaultModel: faux.getModel().id,
    defaultThinkingLevel: "off",
    cronDailySessionStartTime: "00:00",
  } as AppConfig;
  const workspace: WorkspaceInfo = {
    id: "workspace",
    label: "Workspace",
    path: path.join(config.workspacesRoots[0]!, "workspace"),
    kind: "workspace",
    isPinned: false,
    isAssistant: false,
  };
  await fs.mkdir(workspace.path, { recursive: true });
  const service = await PiService.create(config, {} as CronService);
  cleanups.push(() => service.dispose());
  return { config, faux, models, service, workspace };
}

async function createInterruptedSession(
  config: AppConfig,
  models: ReturnType<typeof createModels>,
  workspace: WorkspaceInfo,
) {
  const store = await HarnessSessionStore.create(
    workspace.path,
    workspaceSessionDir(config, workspace.id),
  );
  const { session } = await createPiAgentSession({
    config,
    workspace,
    sessionManager: store,
    modelRuntime: models as unknown as ModelRuntime,
    customTools: [],
  });
  getOrThrow(
    await session.lane.accept(
      { kind: "prompt", operationId: "interrupted", prompt: "unfinished" },
      context,
    ),
  );
  const sessionPath = session.sessionFile;
  await session.dispose();
  return sessionPath;
}

describe("PiService drain and interrupted sessions", () => {
  it("does not run archived interrupted operations during startup", async () => {
    const { config, faux, models, workspace, service } = await createService();
    await service.dispose();
    cleanups.pop();
    await createInterruptedSession(config, models, workspace);
    faux.setResponses([fauxAssistantMessage("must not run")]);
    const restarted = await PiService.create(config, {} as CronService);
    cleanups.push(() => restarted.dispose());

    expect(faux.state.callCount).toBe(0);
  });

  it("aborts an orphaned operation when opened, leaving it idle and ready for a new prompt", async () => {
    const { config, faux, models, service, workspace } = await createService();
    const sessionPath = await createInterruptedSession(config, models, workspace);

    const opened = await service.openSession(workspace, sessionPath);
    const controller = await (service as any).sessionControllers.get(opened.sessionId);
    expect(controller.session.snapshot.lastResult).toMatchObject({
      operationId: "interrupted",
      status: "aborted",
    });
    expect(opened.isStreaming).toBe(false);

    faux.setResponses([fauxAssistantMessage("fresh answer")]);
    await service.prompt(opened.id, "start again", [], "message-1");
    const state = service.getState(opened.id);
    expect(state.isStreaming).toBe(false);
    expect(JSON.stringify(state.messages)).toContain("fresh answer");
  });

  it("rejects new prompts during drain while retaining the active prompt through queueing and completion", async () => {
    const { faux, service, workspace } = await createService();
    const session = await service.createSession(workspace);
    let releaseQueue!: () => void;
    const queue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    vi.spyOn(service as any, "waitForSubagentQueue").mockReturnValue(queue);
    let releaseResponse!: () => void;
    const response = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
      releaseResponse = () => resolve(fauxAssistantMessage("completed"));
    });
    faux.setResponses([async () => response]);

    const active = service.prompt(session.id, "first", [], "message-1");
    expect(service.turns.activeTurns).toBe(1);
    service.turns.beginDrain();

    await expect(service.prompt(session.id, "second", [], "message-2")).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(service.turns.activeTurns).toBe(1);

    releaseQueue();
    await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
    expect(service.turns.activeTurns).toBe(1);
    releaseResponse();
    await active;
    expect(service.turns.activeTurns).toBe(0);
    expect(JSON.stringify(service.getState(session.id).messages)).toContain("completed");
  });
});
