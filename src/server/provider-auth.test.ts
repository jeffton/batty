import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Credential } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ProviderAuthService } from "@/server/provider-auth";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("ProviderAuthService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts and completes the openai-codex manual auth flow", async () => {
    const credentials = new Map<string, Credential>();
    let capturedInput = "";
    const modelRuntime = {
      login: vi.fn(async (_providerId, type, interaction) => {
        expect(type).toBe("oauth");
        interaction.notify({ type: "auth_url", url: "https://auth.openai.com/example" });
        capturedInput = await interaction.prompt({
          type: "manual_code",
          message: "Paste callback URL",
        });
        const credential: Credential = {
          type: "oauth",
          access: createJwt({ "https://api.openai.com/profile": { email: "codex@example.com" } }),
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        };
        credentials.set("openai-codex", credential);
        return credential;
      }),
    } as Pick<ModelRuntime, "login">;
    const service = new ProviderAuthService(modelRuntime, (providerId) =>
      credentials.get(providerId),
    );

    const started = await service.start("openai-codex");

    expect(started.providerId).toBe("openai-codex");
    expect(started.authUrl).toBe("https://auth.openai.com/example");

    await service.complete(started.attemptId, "https://localhost/callback?code=abc");

    expect(capturedInput).toBe("https://localhost/callback?code=abc");
    expect(
      service.getStatus().providers.find((provider) => provider.id === "openai-codex"),
    ).toEqual({
      id: "openai-codex",
      name: "ChatGPT Plus/Pro (Codex Subscription)",
      connected: true,
      authKind: "oauth",
      connectedEmail: "codex@example.com",
    });
  });

  it("rejects auth start when login fails before publishing a URL", async () => {
    const modelRuntime = {
      login: vi.fn(async () => {
        throw new Error("OAuth callback port is unavailable");
      }),
    } as Pick<ModelRuntime, "login">;
    const service = new ProviderAuthService(modelRuntime, () => undefined);

    await expect(service.start("openai-codex")).rejects.toThrow(
      "OAuth callback port is unavailable",
    );
  });

  it("stores API keys for supported providers", async () => {
    const credentials = new Map<string, Credential>();
    const modelRuntime = {
      login: vi.fn(async (providerId, type, interaction) => {
        expect(type).toBe("api_key");
        const credential: Credential = {
          type: "api_key",
          key: await interaction.prompt({ type: "secret", message: "API key" }),
        };
        credentials.set(providerId, credential);
        return credential;
      }),
    } as Pick<ModelRuntime, "login">;
    const service = new ProviderAuthService(modelRuntime, (providerId) =>
      credentials.get(providerId),
    );

    const status = await service.setApiKey("openrouter", "sk-or-v1-secret");

    expect(modelRuntime.login).toHaveBeenCalledWith(
      "openrouter",
      "api_key",
      expect.objectContaining({ prompt: expect.any(Function), notify: expect.any(Function) }),
    );
    expect(status.providers.find((provider) => provider.id === "openrouter")).toEqual({
      id: "openrouter",
      name: "OpenRouter",
      connected: true,
      authKind: "apiKey",
    });
  });

  it("rejects expired attempts", async () => {
    vi.useFakeTimers();

    const modelRuntime = {
      login: vi.fn(async (_providerId, _type, interaction) => {
        interaction.notify({ type: "auth_url", url: "https://auth.openai.com/example" });
        await interaction.prompt({ type: "manual_code", message: "Paste callback URL" });
        return {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        };
      }),
    } as Pick<ModelRuntime, "login">;
    const service = new ProviderAuthService(modelRuntime, () => undefined);
    const started = await service.start("openai-codex");

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);

    await expect(service.complete(started.attemptId, "code-123")).rejects.toThrow(
      "Auth attempt expired",
    );
  });
});
