import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Credential } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ProviderAuthService } from "@/server/provider-auth";

const getDeviceId = () => "12345678-1234-4234-8234-123456789abc";
const callbackUrl = "http://127.0.0.1:1455/auth/callback?code=abc&state=state&client_id=client";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function manualAuthRuntime(credentials = new Map<string, Credential>()) {
  let capturedInput = "";
  const login: ModelRuntime["login"] = vi.fn(async (providerId, type, interaction, options) => {
    expect(type).toBe("oauth");
    expect(options?.getDeviceId?.()).toBe(getDeviceId());
    interaction.notify({ type: "auth_url", url: "https://auth.openai.com/example" });
    capturedInput = await interaction.prompt({
      type: "manual_code",
      message: "Paste callback URL",
    });
    const credential: Credential = {
      type: "oauth",
      access: createJwt({ "https://api.openai.com/profile": { email: "chatgpt@example.com" } }),
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    };
    credentials.set(providerId, credential);
    return credential;
  });
  return { login, credentials, input: () => capturedInput };
}

describe("ProviderAuthService", () => {
  afterEach(() => vi.useRealTimers());

  it("passes the full remote callback URL and installation device ID to OpenAI", async () => {
    const runtime = manualAuthRuntime();
    const service = new ProviderAuthService(
      runtime,
      (id) => runtime.credentials.get(id),
      getDeviceId,
    );
    const started = await service.start("openai");
    expect(started.providerId).toBe("openai");
    expect(started.authUrl).toBe("https://auth.openai.com/example");
    await service.complete(started.attemptId, callbackUrl);
    expect(runtime.input()).toBe(callbackUrl);
    expect(service.getStatus().providers.find((provider) => provider.id === "openai")).toEqual({
      id: "openai",
      name: "ChatGPT subscription",
      connected: true,
      authKind: "oauth",
      connectedEmail: "chatgpt@example.com",
    });
  });

  it("keeps local callback completion available through status refreshes", async () => {
    let finish!: () => void;
    const callback = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const login: ModelRuntime["login"] = vi.fn(async (_id, _type, interaction) => {
      interaction.notify({ type: "auth_url", url: "https://auth.openai.com/example" });
      await callback;
      return {
        type: "oauth" as const,
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      };
    });
    const service = new ProviderAuthService({ login }, () => undefined, getDeviceId);
    const started = await service.start("openai");
    expect(service.getAttemptStatus(started.attemptId)).toEqual({ completed: false });
    finish();
    await callback;
    await Promise.resolve();
    service.getStatus();
    expect(service.getAttemptStatus(started.attemptId)).toEqual({ completed: true });
    await service.complete(started.attemptId, "");
    await service.dispose();
  });

  it("cancels the previous login when starting a new attempt", async () => {
    const runtime = manualAuthRuntime();
    const service = new ProviderAuthService(runtime, () => undefined, getDeviceId);
    const first = await service.start("openai");
    const signal = vi.mocked(runtime.login).mock.calls[0]![2].signal;
    const second = await service.start("openai");
    expect(signal?.aborted).toBe(true);
    expect(() => service.getAttemptStatus(first.attemptId)).toThrow("Unknown auth attempt");
    await service.complete(second.attemptId, callbackUrl);
  });

  it("serializes simultaneous starts and leaves only the latest login active", async () => {
    const runtime = manualAuthRuntime();
    const service = new ProviderAuthService(runtime, () => undefined, getDeviceId);
    const [first, second] = await Promise.all([service.start("openai"), service.start("openai")]);
    expect(vi.mocked(runtime.login).mock.calls[0]![2].signal?.aborted).toBe(true);
    expect(() => service.getAttemptStatus(first.attemptId)).toThrow("Unknown auth attempt");
    expect(service.getAttemptStatus(second.attemptId)).toEqual({ completed: false });
    await service.complete(second.attemptId, callbackUrl);
  });

  it("rejects auth start when login fails before publishing a URL", async () => {
    const runtime = {
      login: vi.fn(async () => {
        throw new Error("OpenAI authorization failed");
      }),
    };
    const service = new ProviderAuthService(runtime, () => undefined, getDeviceId);
    await expect(service.start("openai")).rejects.toThrow("OpenAI authorization failed");
  });

  it("reports token exchange errors after manual input", async () => {
    const login: ModelRuntime["login"] = vi.fn(async (_id, _type, interaction) => {
      interaction.notify({ type: "auth_url", url: "https://auth.openai.com/example" });
      await interaction.prompt({ type: "manual_code", message: "Paste callback URL" });
      throw new Error("OpenAI rejected the callback");
    });
    const service = new ProviderAuthService({ login }, () => undefined, getDeviceId);
    const started = await service.start("openai");
    await expect(service.complete(started.attemptId, callbackUrl)).rejects.toThrow(
      "OpenAI rejected the callback",
    );
  });

  it("stores API keys for supported providers", async () => {
    const credentials = new Map<string, Credential>();
    const login: ModelRuntime["login"] = vi.fn(async (providerId, type, interaction) => {
      expect(type).toBe("api_key");
      const credential: Credential = {
        type: "api_key",
        key: await interaction.prompt({ type: "secret", message: "API key" }),
      };
      credentials.set(providerId, credential);
      return credential;
    });
    const service = new ProviderAuthService({ login }, (id) => credentials.get(id), getDeviceId);
    const status = await service.setApiKey("openrouter", "sk-or-v1-secret");
    expect(login).toHaveBeenCalledWith(
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
    const runtime = manualAuthRuntime();
    const service = new ProviderAuthService(runtime, () => undefined, getDeviceId);
    const started = await service.start("openai");
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    await expect(service.complete(started.attemptId, callbackUrl)).rejects.toThrow(
      "Auth attempt expired",
    );
  });
});
