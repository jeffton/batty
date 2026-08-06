import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readStoredOptions } from "../options";
import type { RouteContext } from "./context";
import { registerSettingsRoutes } from "./settings";

const tempDirs: string[] = [];

function createContext(battyDir: string, models: Array<{ id: string; provider: string }>) {
  const app = Fastify();
  const config = {
    battyDir,
    appTitle: "Batty",
    appColor: "neutral",
  };
  const context = {
    app,
    config,
    routePath: (route: string) => route,
    service: {
      listModels: vi.fn(async () =>
        models.map((model) => ({
          ...model,
          label: model.id,
          reasoning: true,
          supportsImages: false,
        })),
      ),
    },
  } as unknown as RouteContext;

  registerSettingsRoutes(context);
  return { app, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("default model settings route", () => {
  it("persists the selected provider and model and updates the runtime config", async () => {
    const battyDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-settings-route-"));
    tempDirs.push(battyDir);
    const { app, config } = createContext(battyDir, [
      { id: "openai-codex/gpt-5.6-sol", provider: "openai-codex" },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/settings/default-model",
      payload: { modelId: "openai-codex/gpt-5.6-sol" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
    });
    expect(config).toMatchObject({
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
    });
    expect(await readStoredOptions(battyDir)).toMatchObject({
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
    });

    await app.close();
  });

  it("rejects a model outside the available model list", async () => {
    const battyDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-settings-route-"));
    tempDirs.push(battyDir);
    const { app } = createContext(battyDir, []);

    const response = await app.inject({
      method: "POST",
      url: "/api/settings/default-model",
      payload: { modelId: "unknown/model" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ message: "Invalid default model" });

    await app.close();
  });
});
