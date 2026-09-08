import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readStoredOptions } from "../options";
import type { ProviderUsage } from "@/shared/types";
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
  const service = {
    listModels: vi.fn(async () =>
      models.map((model) => ({
        ...model,
        label: model.id,
        reasoning: true,
        thinkingLevels: ["minimal", "low", "medium", "high"],
        supportsImages: false,
      })),
    ),
    getProviderUsage: vi.fn(async (): Promise<ProviderUsage> => ({ windows: [] })),
  };
  const context = {
    app,
    config,
    routePath: (route: string) => route,
    service,
  } as unknown as RouteContext;

  registerSettingsRoutes(context);
  return { app, config, service };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("provider usage route", () => {
  it("delegates a provider and model query to the service", async () => {
    const battyDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-settings-route-"));
    tempDirs.push(battyDir);
    const { app, service } = createContext(battyDir, []);
    service.getProviderUsage.mockResolvedValue({
      windows: [
        { id: "primary", usedPercent: 10, windowSeconds: 18_000, resetsAt: 1_700_000_000_000 },
      ],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/provider-usage?provider=openai-codex&model=gpt-5.6-terra",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      windows: [
        { id: "primary", usedPercent: 10, windowSeconds: 18_000, resetsAt: 1_700_000_000_000 },
      ],
    });
    expect(service.getProviderUsage).toHaveBeenCalledWith("openai-codex", "gpt-5.6-terra");
    await app.close();
  });

  it("requires both provider and model", async () => {
    const battyDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-settings-route-"));
    tempDirs.push(battyDir);
    const { app } = createContext(battyDir, []);

    const response = await app.inject({
      method: "GET",
      url: "/api/provider-usage?provider=openai-codex",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ message: "Missing provider or model" });
    await app.close();
  });
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
      payload: { modelId: "openai-codex/gpt-5.6-sol", thinkingLevel: "medium" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
      defaultThinkingLevel: "medium",
    });
    expect(config).toMatchObject({
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
      defaultThinkingLevel: "medium",
    });
    expect(await readStoredOptions(battyDir)).toMatchObject({
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
      defaultThinkingLevel: "medium",
    });

    await app.close();
  });

  it("rejects a thinking level unsupported by the selected model", async () => {
    const battyDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-settings-route-"));
    tempDirs.push(battyDir);
    const { app } = createContext(battyDir, [
      { id: "openai-codex/gpt-5.6-sol", provider: "openai-codex" },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/settings/default-model",
      payload: { modelId: "openai-codex/gpt-5.6-sol", thinkingLevel: "max" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ message: "Invalid default thinking level" });

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
