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
    let credential: { type: "oauth"; access: string; refresh: string; expires: number } | undefined;
    let capturedInput = "";

    const authStorage = {
      get: vi.fn(() => credential),
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
          capturedInput = (await callbacks.onManualCodeInput?.()) ?? "";
          credential = {
            type: "oauth",
            access: createJwt({ email: "codex@example.com" }),
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
    expect(service.getStatus().providers).toEqual([
      {
        id: "openai-codex",
        name: "ChatGPT Plus/Pro (Codex Subscription)",
        connected: false,
      },
    ]);

    await service.complete(started.attemptId, "https://localhost/callback?code=abc");

    expect(capturedInput).toBe("https://localhost/callback?code=abc");
    expect(service.getStatus().providers).toEqual([
      {
        id: "openai-codex",
        name: "ChatGPT Plus/Pro (Codex Subscription)",
        connected: true,
        connectedEmail: "codex@example.com",
      },
    ]);
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
