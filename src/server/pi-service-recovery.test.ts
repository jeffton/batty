import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BACKGROUND_CONTEXT as context,
  getOrThrow,
  laneConfig,
} from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "./config";
import type { CronService } from "./cron";
import { createPiAgentSession } from "./pi-agent-session";
import { HarnessSessionStore } from "./harness-session-store";
import { PiService } from "./pi-service";
import { workspaceSessionDir } from "./pi-paths";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks();
});

describe("startup operation recovery", () => {
  it.each(["model", "resource", "storage"])(
    "reports a session %s failure and recovers the following session",
    async (failure) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-service-recovery-"));
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
      await fs.mkdir(config.workspacesRoots[0]!, { recursive: true });
      const completed = vi.fn(async () => {});
      const service = await PiService.create(config, {} as CronService, completed);
      cleanups.push(() => service.dispose());
      const failedPaths: string[] = [];
      let recoverableId!: string;
      for (const id of ["a-failing", "b-recoverable"]) {
        const workspace = {
          id,
          label: id,
          path: path.join(config.workspacesRoots[0]!, id),
          kind: "workspace" as const,
          isPinned: false,
          isAssistant: false,
        };
        await fs.mkdir(workspace.path, { recursive: true });
        const store = await HarnessSessionStore.create(
          workspace.path,
          workspaceSessionDir(config, id),
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
            { kind: "prompt", operationId: id, prompt: "Recover me" },
            context,
          ),
        );
        if (id === "a-failing" && failure === "model") {
          await store.native.setValue(
            laneConfig("main"),
            {
              ...(await store.configuration())!,
              model: { provider: "missing-provider", modelId: "missing-model" },
            },
            context,
          );
        }
        await session.dispose();
        if (id === "a-failing") {
          failedPaths.push(session.sessionFile);
          if (failure === "resource") {
            await fs.mkdir(path.join(workspace.path, ".batty"), { recursive: true });
            await fs.writeFile(
              path.join(workspace.path, ".batty", "settings.json"),
              "invalid JSON",
            );
          }
          if (failure === "storage") await fs.writeFile(session.sessionFile, "invalid JSON\n");
        } else recoverableId = session.sessionId;
      }
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const open = vi.spyOn(service, "openSession");
      faux.setResponses([fauxAssistantMessage("recovered")]);
      await expect(service.recoverOpenOperations()).resolves.toBeUndefined();
      await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalledWith("Failed to recover Pi session", {
        workspaceId: "a-failing",
        sessionPath: failedPaths[0],
        error: expect.any(Error),
      });
      expect(open.mock.calls.map(([workspace]) => workspace.id)).toEqual(
        failure === "storage" ? ["b-recoverable"] : ["a-failing", "b-recoverable"],
      );
      expect(faux.state.callCount).toBe(1);
      expect(completed.mock.calls[0]).toEqual([expect.objectContaining({ id: recoverableId })]);
      const state = service.getState(recoverableId);
      expect(state.messages.filter((message) => message.role === "user")).toHaveLength(1);
    },
  );
});
