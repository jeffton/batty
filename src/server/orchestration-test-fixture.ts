import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup } from "./test-cleanup";
export { cleanup } from "./test-cleanup";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createOrchestration } from "./orchestration.js";

export const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition did not settle");
};

export async function fixture(
  tokensPerSecond = 10000,
  onError: (error: unknown) => void = console.error,
  assistantWorkspaceId?: string,
  networkAvailable?: () => Promise<boolean>,
) {
  const directory = await mkdtemp(join(tmpdir(), "batty-orchestration-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider({
    tokensPerSecond,
    models: [
      { id: "faux-1", reasoning: true },
      { id: "faux-2", reasoning: true },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const orchestration = createOrchestration(
    {
      fileStorage: { rootDir: join(directory, "sent-files") },
      onError,
      workspaces: [
        {
          id: "test",
          path: directory,
          label: "Test",
          kind: "workspace",
          isPinned: false,
          isAssistant: assistantWorkspaceId === "test",
        },
        {
          id: "other",
          path: "/tmp",
          label: "Other",
          kind: "workspace",
          isPinned: false,
          isAssistant: assistantWorkspaceId === "other",
        },
      ],
    },
    networkAvailable,
  );
  registry.install(orchestration.extension);
  let harness: Harness;
  const open = async () => {
    harness = await Harness.open(
      await openNodeSqliteStorage(join(directory, "session.sqlite")),
      { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? directory }) },
      context,
    );
    const main = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    await orchestration.bind(harness, main);
    return { harness, main };
  };
  cleanup.push(async () => {
    orchestration.close();
    await harness.close(context);
  });
  return { faux, models, orchestration, open, registry, directory };
}
