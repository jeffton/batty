import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  type ToolDefinition,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createPiAgentSession } from "./pi-agent-session";
import { SessionStore } from "./session-store";
import { battyAgentDir } from "./pi-paths";
import type { AppConfig } from "./config";

export interface AgentSessionFixtureOptions {
  tools?: ToolDefinition<any>[];
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  retry?: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number };
  extensionFactories?: ExtensionFactory[];
  prepare?: (root: string, config: AppConfig) => Promise<void>;
}

export async function createAgentSessionFixture(options: AgentSessionFixtureOptions = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "batty-agent-session-")));
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    authPath: path.join(root, "auth.json"),
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const workspace = {
    id: "test",
    path: root,
    label: "Test",
    kind: "workspace" as const,
    isPinned: false,
    isAssistant: false,
  };
  const config = {
    battyDir: path.join(root, "data"),
    selfPath: root,
    cronDailySessionStartTime: "00:00",
    defaultProvider: faux.getModel().provider,
    defaultModel: faux.getModel().id,
    defaultThinkingLevel: "off",
  } as AppConfig;
  const agentDir = battyAgentDir(config);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: faux.getModel().provider,
      defaultModel: faux.getModel().id,
      defaultThinkingLevel: "off",
      compaction: { enabled: false, ...options.compaction },
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0, ...options.retry },
    }),
  );
  await options.prepare?.(root, config);
  const configuration = {
    config,
    workspace,
    modelRuntime,
    customTools: options.tools ?? [],
    extensionFactories: options.extensionFactories,
  };
  let session = (
    await createPiAgentSession({
      ...configuration,
      sessionManager: await SessionStore.create(root, path.join(root, "sessions")),
    })
  ).session;
  const forks: (typeof session)[] = [];
  return {
    root,
    faux,
    models: modelRuntime,
    modelRuntime,
    config,
    workspace,
    get session() {
      return session;
    },
    async reopen() {
      const file = session.sessionFile;
      await session.dispose();
      session = (
        await createPiAgentSession({
          ...configuration,
          sessionManager: await SessionStore.open(file),
        })
      ).session;
      return session;
    },
    async fork(entryId: string) {
      const forked = (
        await createPiAgentSession({
          ...configuration,
          sessionManager: await session.sessionManager.fork(path.join(root, "sessions"), entryId),
        })
      ).session;
      forks.push(forked);
      return forked;
    },
    async cleanup() {
      for (const fork of forks) await fork.dispose();
      await session.dispose();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
