import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "./config";
import type { CronService } from "./cron";
import { createPiAgentSession } from "./pi-agent-session";
import { SessionStore } from "./session-store";
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
  const models = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  vi.spyOn(ModelRuntime, "create").mockResolvedValue(models);
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
  models: ModelRuntime,
  workspace: WorkspaceInfo,
) {
  const store = await SessionStore.create(
    workspace.path,
    workspaceSessionDir(config, workspace.id),
  );
  const { session } = await createPiAgentSession({
    config,
    workspace,
    sessionManager: store,
    modelRuntime: models,
    customTools: [],
  });
  await session.sessionManager.appendMessage({
    role: "user",
    content: "unfinished",
    timestamp: Date.now(),
  });
  const sessionPath = session.sessionFile;
  await session.dispose();
  return sessionPath;
}

describe("PiService checkpoint and recovery", () => {
  it("publishes native progress without projecting or cloning full history again", async () => {
    const { service, workspace } = await createService();
    const opened = await service.createSession(workspace);
    const session = (service as any).requireSession(opened.id).session;
    const first = service.getSnapshot(opened.id);
    const projection = vi.spyOn(session.sessionManager, "buildSessionProjection");
    const history = vi.spyOn(session.sessionManager, "getEntriesUpTo");
    const view = {
      ...session.view,
      docs: {
        ...session.view.docs,
        "pi.live": {
          ...session.view.docs["pi.live"],
          tools: [
            { id: 1, callId: "progress", name: "bash", status: "running", output: "working" },
          ],
        },
      },
    };
    const next = service.getSnapshot(opened.id, view, first);
    expect(next.messages).toBe(first.messages);
    expect(next.metadata.contextTokens).toBe(first.metadata.contextTokens);
    expect(projection).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

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

  it("opens an unfinished transcript idle and ready for a new prompt", async () => {
    const { config, faux, models, service, workspace } = await createService();
    const sessionPath = await createInterruptedSession(config, models, workspace);

    const opened = await service.openSession(workspace, sessionPath);
    expect(faux.state.callCount).toBe(0);
    expect(opened.isStreaming).toBe(false);

    faux.setResponses([fauxAssistantMessage("fresh answer")]);
    await service.prompt(opened.id, "start again", [], "message-1");
    const state = service.getState(opened.id);
    expect(state.isStreaming).toBe(false);
    expect(JSON.stringify(state.messages)).toContain("fresh answer");
  });

  it("checkpoints a running generation and recovers admitted follow-ups without waiting for completion", async () => {
    const { config, faux, service, workspace } = await createService();
    const state = await service.createSession(workspace);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const interrupted = vi.fn();
    faux.setResponses([
      async (_context, options) => {
        entered();
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener(
            "abort",
            () => {
              interrupted();
              resolve();
            },
            { once: true },
          ),
        );
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
    ]);
    const active = service.prompt(state.id, "first", [], "message-1").then(
      () => undefined,
      (error: unknown) => error,
    );
    await started;
    expect(await service.prompt(state.id, "follow-up", [], "message-2", "followUp")).toMatchObject({
      disposition: "queued",
    });
    await service.prepareRestart();
    expect(interrupted).toHaveBeenCalledOnce();
    await active;
    await expect(service.prompt(state.id, "new input", [], "message-3")).rejects.toMatchObject({
      statusCode: 503,
    });
    faux.setResponses([
      fauxAssistantMessage("Recovered first"),
      fauxAssistantMessage("Recovered follow-up"),
    ]);
    const restarted = await PiService.create(config, {} as CronService);
    cleanups.push(() => restarted.dispose());
    await restarted.restoreDurableSessions([workspace]);
    await (restarted as any).requireSession(state.id).session.waitForIdle();
    const recovered = restarted.getState(state.id);
    expect(JSON.stringify(recovered.messages)).toContain("Recovered follow-up");
    expect(recovered.messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(faux.state.callCount).toBe(3);
  });
});
