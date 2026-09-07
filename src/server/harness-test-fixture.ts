import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentHarnessOptions } from "@earendil-works/pi-agent-core";
import { HarnessController } from "./harness-controller";
import { HarnessSessionStore } from "./harness-session-store";

export async function createHarnessFixture(options: Partial<AgentHarnessOptions<any>> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-harness-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const resources = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
  });
  const store = await HarnessSessionStore.create(root, path.join(root, "sessions"));
  const configuration = {
    models,
    model: faux.getModel(),
    compaction: settings.getCompactionSettings(),
    ...options,
  };
  let session = await HarnessController.create(store, configuration, settings, resources);
  return {
    root,
    faux,
    models,
    get session() {
      return session;
    },
    async reopen() {
      const file = session.sessionFile;
      await session.dispose();
      session = await HarnessController.create(
        await HarnessSessionStore.open(file),
        configuration,
        settings,
        resources,
      );
      return session;
    },
    async cleanup() {
      await session.dispose();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
