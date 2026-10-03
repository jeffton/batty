import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "./config";
import type { CronService } from "./cron";
import { PiService } from "./pi-service";
import { SessionStore } from "./session-store";
import type { WorkspaceInfo } from "@/shared/types";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks();
});

describe("normal ephemeral controller disposal", () => {
  it("runs a queued successor only after old controller and browser cleanup finish", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-disposal-"));
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
      path: path.join(root, "workspaces", "workspace"),
      kind: "workspace",
      isPinned: false,
      isAssistant: false,
    };
    await fs.mkdir(workspace.path, { recursive: true });
    const service = await PiService.create(config, {} as CronService);
    cleanups.push(() => service.dispose());
    const runtime = service as any;
    const parent = await service.createSession(workspace);
    const childId = randomUUID();
    const childReady = gate();
    const finishChild = gate();
    const finishParent = gate();
    const cleanupStarted = gate();
    const finishResources = gate();
    const finishBrowser = gate();
    cleanups.push(async () => {
      finishChild.resolve();
      finishParent.resolve();
      finishResources.resolve();
      finishBrowser.resolve();
    });
    const closeBrowser = runtime.browserService.closeSession.bind(runtime.browserService);
    vi.spyOn(runtime.browserService, "closeSession").mockImplementation(async (id) => {
      if (id === childId) await finishBrowser.promise;
      await closeBrowser(id);
    });
    let oldChild: any;
    faux.setResponses([
      async () => {
        await finishChild.promise;
        return fauxAssistantMessage("First child result");
      },
      async (_context, options) => {
        await Promise.race([
          finishParent.promise,
          new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          ),
        ]);
        return fauxAssistantMessage("First parent response");
      },
      fauxAssistantMessage("Second child result"),
      fauxAssistantMessage("Second parent response"),
    ]);
    const first = runtime.runDetachedSubagentSession({
      sessionId: childId,
      workspace,
      parentSessionId: parent.id,
      parentSessionPath: runtime.requireSession(parent.id).session.sessionFile,
      parentSubagentDepth: 0,
      prompt: "First task",
      modelId: `faux/${faux.getModel().id}`,
      thinkingLevel: "off",
      includePreviousContext: false,
      respondIn: "session",
      deliveryMode: "prompt",
      onReady: () => {
        oldChild = runtime.requireSession(childId).session;
        const disposeResources = oldChild.resources.dispose.bind(oldChild.resources);
        vi.spyOn(oldChild.resources, "dispose").mockImplementation(async () => {
          cleanupStarted.resolve();
          await finishResources.promise;
          await disposeResources();
        });
        childReady.resolve();
      },
    });
    await childReady.promise;
    expect(
      await runtime.continueSubagent(workspace, parent.id, childId, "Second task", true, true),
    ).toMatchObject({ isError: false });
    finishChild.resolve();
    await cleanupStarted.promise;
    await vi.waitFor(() => expect(faux.state.callCount).toBe(2));
    expect(oldChild.isClosing).toBe(true);
    // SQLite is already closed, so the queued factory owns a fresh writer while it waits.
    const reopened = await SessionStore.open(oldChild.sessionFile);
    expect(reopened).not.toBe(oldChild.sessionManager);
    expect(runtime.requireSession(childId).session).toBe(oldChild);
    finishResources.resolve();
    await oldChild.dispose();
    expect(runtime.requireSession(childId).session).toBe(oldChild);
    expect(faux.state.callCount).toBe(2);
    finishBrowser.resolve();
    finishParent.resolve();
    await first;
    await vi.waitFor(async () => {
      const child = await SessionStore.read(oldChild.sessionFile);
      expect(
        child.entries.filter(
          (entry) => entry.type === "custom" && entry.customType === "batty-subagent-delivery",
        ),
      ).toHaveLength(2);
    });
    const parentEntries = runtime.requireSession(parent.id).session.sessionManager.getEntries();
    const replies = parentEntries.filter(
      (entry: any) =>
        entry.type === "custom_message" &&
        entry.details?.battyResultReplyId?.startsWith(`subagent:${childId}:`),
    );
    expect(replies).toHaveLength(2);
    expect(new Set(replies.map((entry: any) => entry.details.battyResultReplyId)).size).toBe(2);
    expect(faux.state.callCount).toBe(4);
    await reopened.release();
  });
});
