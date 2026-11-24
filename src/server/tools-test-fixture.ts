import { afterEach, expect } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createTools } from "./tools";

export function createToolsTestFixture() {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function fixture(persistent = false) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-tools-test-"));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const config = { battyDir: directory, browserMaxTabs: 4, workspacesRoots: [directory] } as any;
    const tools = await createTools(config);
    cleanups.push(() => tools.close());
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(tools.extension);
    const settings = {
      get extensions() {
        return registry
          .snapshot()
          .installed()
          .filter((extension) => !extension.name.startsWith("batty-mcp-workspace-"));
      },
    };
    let harness = await Harness.open(
      persistent
        ? await openNodeSqliteStorage(path.join(directory, "session.sqlite"))
        : new MemoryStorage(),
      { models, registry, settings, env: () => new NodeExecutionEnv({ cwd: directory }) },
      BACKGROUND_CONTEXT,
    );
    tools.bindHarness(harness);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
    let main = await harness.root(BACKGROUND_CONTEXT, {
      agent: { cwd: directory, model: { provider: "faux", modelId: "faux-1" } },
    });
    const reopen = async () => {
      await harness.close(BACKGROUND_CONTEXT);
      harness = await Harness.open(
        await openNodeSqliteStorage(path.join(directory, "session.sqlite")),
        { models, registry, settings, env: () => new NodeExecutionEnv({ cwd: directory }) },
        BACKGROUND_CONTEXT,
      );
      tools.bindHarness(harness);
      main = await harness.root(BACKGROUND_CONTEXT);
      harness.resume();
      return { harness, main };
    };
    const run = async (code: string) => {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      const settled = await (
        await main.submit({ type: "input", content: "run script" }, BACKGROUND_CONTEXT)
      ).wait(BACKGROUND_CONTEXT);
      expect(settled.status).toBe("done");
      const view = await main.watch(BACKGROUND_CONTEXT);
      const result = view.value.entries.findLast(
        (entry) =>
          entry.kind === "pi.tool-result" &&
          entry.model?.[0]?.role === "toolResult" &&
          entry.model[0].toolName === "codemode",
      )!.model![0] as any;
      view.stop();
      return result;
    };
    const api = {
      callId: "call",
      taskId: 1,
      conversationId: 1,
      env: { cwd: directory },
      agent: async () => ({ cwd: directory, tools: tools.extension.tools }),
      output: () => {},
      details: async () => {},
      snapshot: async () => undefined,
      commit: async (fn: any) => main.commit(fn, BACKGROUND_CONTEXT),
    } as any;
    return { directory, config, tools, api, run, harness, main, registry, faux, reopen };
  }
  return { fixture, cleanups };
}
