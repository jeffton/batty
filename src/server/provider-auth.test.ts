import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
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
    let credential:
      | { type: "oauth"; access: string; refresh: string; expires: number }
      | { type: "api_key"; key: string }
      | undefined;
    let capturedInput = "";

    const authStorage = {
      get: vi.fn((providerId: string) => (providerId === "openai-codex" ? credential : undefined)),
      getOAuthProviders: vi.fn(() => [
        {
          id: "openai-codex",
          name: "ChatGPT Plus/Pro (Codex Subscription)",
        },
      ]),
      set: vi.fn((providerId: string, nextCredential: typeof credential) => {
        if (providerId === "openai-codex") {
          credential = nextCredential;
        }
      }),
      login: vi.fn(
        async (
          _providerId: string,
          callbacks: {
            onAuth: (info: { url: string }) => void;
            onManualCodeInput?: () => Promise<string>;
          },
        ) => {
          callbacks.onAuth({ url: "https://auth.openai.com/example" });
          capturedInput = (await callbacks.onManualCodeInput?.()) ?? "";
          credential = {
            type: "oauth",
            access: createJwt({ "https://api.openai.com/profile": { email: "codex@example.com" } }),
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          };
        },
      ),
    } as unknown as AuthStorage;

    const service = new ProviderAuthService(authStorage);
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

  it("stores API keys for supported providers", () => {
    const credentials = new Map<string, { type: "api_key"; key: string }>();
    const authStorage = {
      get: vi.fn((providerId: string) => credentials.get(providerId)),
      getOAuthProviders: vi.fn(() => [
        {
          id: "openai-codex",
          name: "ChatGPT Plus/Pro (Codex Subscription)",
        },
      ]),
      set: vi.fn((providerId: string, credential: { type: "api_key"; key: string }) => {
        credentials.set(providerId, credential);
      }),
    } as unknown as AuthStorage;

    const service = new ProviderAuthService(authStorage);
    const status = service.setApiKey("openrouter", "sk-or-v1-secret");

    expect(authStorage.set).toHaveBeenCalledWith("openrouter", {
      type: "api_key",
      key: "sk-or-v1-secret",
    });
    expect(status.providers.find((provider) => provider.id === "openrouter")).toEqual({
      id: "openrouter",
      name: "OpenRouter",
      connected: true,
      authKind: "apiKey",
    });
  });

  it("rejects expired attempts", async () => {
    vi.useFakeTimers();

    const authStorage = {
      get: vi.fn(() => undefined),
      getOAuthProviders: vi.fn(() => [
        {
          id: "openai-codex",
          name: "ChatGPT Plus/Pro (Codex Subscription)",
        },
      ]),
      login: vi.fn(
        async (
          _providerId: string,
          callbacks: {
            onAuth: (info: { url: string }) => void;
            onManualCodeInput?: () => Promise<string>;
          },
        ) => {
          callbacks.onAuth({ url: "https://auth.openai.com/example" });
          await callbacks.onManualCodeInput?.();
        },
      ),
    } as unknown as AuthStorage;

    const service = new ProviderAuthService(authStorage);
    const started = await service.start("openai-codex");

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);

    await expect(service.complete(started.attemptId, "code-123")).rejects.toThrow(
      "Auth attempt expired",
    );
  });
});
