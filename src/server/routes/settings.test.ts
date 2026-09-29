import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readStoredOptions } from "../options";
import { environmentFilePath } from "../config";
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
    startProviderAuth: vi.fn(async () => ({
      attemptId: "attempt-1",
      providerId: "openai",
      authUrl: "https://auth.openai.com/example",
      expiresAt: Date.now() + 60_000,
    })),
    completeProviderAuth: vi.fn(async () => ({ providers: [] })),
    getProviderAuthAttemptStatus: vi.fn(() => ({ completed: true })),
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

describe("environment settings routes", () => {
  it("lists names without values and persists setting and removing variables", async () => {
    const battyDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-settings-route-"));
    tempDirs.push(battyDir);
    const { app } = createContext(battyDir, []);
    const name = "BATTY_ENV_TEST_SECRET";
    try {
      expect(
        (await app.inject({ method: "GET", url: "/api/settings/environment" })).json(),
      ).toEqual({ names: [] });
      const set = await app.inject({
        method: "PUT",
        url: `/api/settings/environment/${name}`,
        payload: { value: "hidden-secret" },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json()).toEqual({ names: [name] });
      expect(set.body).not.toContain("hidden-secret");
      expect(process.env[name]).toBe("hidden-secret");
      expect(JSON.parse(await fs.readFile(environmentFilePath(battyDir), "utf8"))).toEqual({
        [name]: "hidden-secret",
      });
      const listed = await app.inject({ method: "GET", url: "/api/settings/environment" });
      expect(listed.json()).toEqual({ names: [name] });
      expect(listed.body).not.toContain("hidden-secret");
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/settings/environment/${name}`,
      });
      expect(removed.json()).toEqual({ names: [] });
      expect(process.env[name]).toBeUndefined();
      expect(JSON.parse(await fs.readFile(environmentFilePath(battyDir), "utf8"))).toEqual({});
    } finally {
      delete process.env[name];
      await app.close();
    }
  });

  it("preserves concurrent updates and restricts permissions on replacement", async () => {
    const battyDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-settings-route-"));
    tempDirs.push(battyDir);
    const { app } = createContext(battyDir, []);
    const filePath = environmentFilePath(battyDir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{}", { mode: 0o644 });
    const names = ["BATTY_ENV_TEST_ONE", "BATTY_ENV_TEST_TWO"];
    try {
      await Promise.all(
        names.map((name) =>
          app.inject({
            method: "PUT",
            url: `/api/settings/environment/${name}`,
            payload: { value: "secret" },
          }),
        ),
      );
      expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(
        Object.fromEntries(names.map((name) => [name, "secret"])),
      );
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    } finally {
      for (const name of names) delete process.env[name];
      await app.close();
    }
  });

  it("rejects invalid names and non-string values", async () => {
    const battyDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-settings-route-"));
    tempDirs.push(battyDir);
    const { app } = createContext(battyDir, []);
    for (const [url, payload] of [
      ["/api/settings/environment/1INVALID", { value: "secret" }],
      ["/api/settings/environment/VALID", { value: 42 }],
    ] as const) {
      const response = await app.inject({ method: "PUT", url, payload });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("secret");
    }
    await app.close();
  });
});

describe("OpenAI ChatGPT auth routes", () => {
  it("starts OpenAI login, reports local completion, and accepts a full remote callback URL", async () => {
    const battyDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-settings-route-"));
    tempDirs.push(battyDir);
    const { app, service } = createContext(battyDir, []);
    try {
      const start = await app.inject({ method: "POST", url: "/api/provider-auth/openai/start" });
      expect(start.statusCode).toBe(200);
      expect(service.startProviderAuth).toHaveBeenCalledWith("openai");
      const status = await app.inject({
        method: "GET",
        url: "/api/provider-auth/openai/attempt/attempt-1",
      });
      expect(status.json()).toEqual({ completed: true });
      expect(service.getProviderAuthAttemptStatus).toHaveBeenCalledWith("attempt-1");
      const callbackUrl =
        "http://127.0.0.1:1455/auth/callback?code=abc&state=state&client_id=client";
      const complete = await app.inject({
        method: "POST",
        url: "/api/provider-auth/openai/complete",
        payload: { attemptId: "attempt-1", callbackUrl },
      });
      expect(complete.statusCode).toBe(200);
      expect(service.completeProviderAuth).toHaveBeenCalledWith("attempt-1", callbackUrl);
    } finally {
      await app.close();
    }
  });
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
