// @vitest-environment node
import { expect, it, vi } from "vite-plus/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import path from "node:path";
import { InMemoryCredentialStore, type Credential } from "@earendil-works/pi-ai";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { ProviderAuthService } from "./provider-auth";

it.each(["gpt-6.1-sol", "gpt-6.2-sol", "gpt-6.2-astra"])(
  "puts %s OAuth instructions in the stable developer prefix",
  async (modelId) => {
    const credentials = new InMemoryCredentialStore();
    const access = `header.${Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
      }),
    ).toString("base64url")}.signature`;
    await credentials.modify("openai-codex", async () => ({
      type: "oauth",
      access,
      refresh: "fixture-refresh",
      expires: Date.now() + 3600000,
    }));
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      refreshOnCreate: false,
    });
    const model = runtime.getModel("openai-codex", modelId)!;
    expect(model.api).toBe("openai-codex-responses");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const completed = JSON.stringify({
        type: "response.completed",
        response: { id: "fixture-response", status: "completed", output: [] },
      });
      return new Response(`data: ${completed}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const systemPrompt = "Fixture developer instructions";
    const first = { role: "user", content: "First fixture input", timestamp: 1 } as const;
    const second = { role: "user", content: "Second fixture input", timestamp: 2 } as const;
    const options = { sessionId: "fixture-cache-key", transport: "sse", fetch } as const;
    const answer = await runtime
      .streamSimple(model, { systemPrompt, messages: [first] }, options)
      .result();
    expect(answer.stopReason).toBe("stop");
    const followUp = await runtime
      .streamSimple(model, { systemPrompt, messages: [first, answer, second] }, options)
      .result();
    expect(followUp.stopReason).toBe("stop");
    expect(fetch).toHaveBeenCalledTimes(2);
    const bodies = fetch.mock.calls.map(([, request]) => {
      const headers = new Headers(request?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${access}`);
      const body = request?.body;
      return JSON.parse(
        headers.get("content-encoding") === "zstd"
          ? zstdDecompressSync(body as Uint8Array).toString("utf8")
          : String(body),
      );
    });
    for (const body of bodies) {
      expect(body).not.toHaveProperty("instructions");
      expect(body.prompt_cache_key).toBe(options.sessionId);
      expect(body.input[0]).toMatchObject({
        role: "developer",
        content: expect.stringContaining(systemPrompt),
      });
      expect(body.input[1]).toMatchObject({ role: "user" });
    }
    expect(bodies[1].input.slice(0, 2)).toEqual(bodies[0].input);
  },
);

it.each(["google", "openrouter"] as const)(
  "persists %s keys and restores connected status in a fresh runtime",
  async (providerId) => {
    const dir = await mkdtemp(path.join(tmpdir(), "batty-provider-auth-"));
    const authPath = path.join(dir, "auth.json");
    const options = { authPath, modelsPath: null, refreshOnCreate: false };
    const runtime = await ModelRuntime.create(options);
    const service = new ProviderAuthService(
      runtime,
      (id) => readStoredCredential(id, authPath),
      () => "test-device",
    );
    const key = `fixture-${providerId}-key`;
    const status = await service.setApiKey(providerId, `  ${key}  `);
    expect(status.providers.find((provider) => provider.id === providerId)).toMatchObject({
      connected: true,
      authKind: "apiKey",
    });
    expect(JSON.stringify(status)).not.toContain(key);
    expect(readStoredCredential(providerId, authPath)).toEqual({ type: "api_key", key });
    await service.dispose();

    const restarted = await ModelRuntime.create(options);
    const restored = new ProviderAuthService(
      restarted,
      (id) => readStoredCredential(id, authPath),
      () => "test-device",
    );
    expect(
      restored.getStatus().providers.find((provider) => provider.id === providerId),
    ).toMatchObject({
      connected: true,
      authKind: "apiKey",
    });
    expect((await restarted.getAuth(providerId))?.auth.apiKey).toBe(key);
    await restored.dispose();
  },
);

it.each(["openai-codex", "anthropic"] as const)(
  "completes %s through its real SDK flow using isolated credentials",
  async (providerId) => {
    const credentials = new InMemoryCredentialStore();
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      refreshOnCreate: false,
    });
    const saved = new Map<string, Credential>();
    const service = new ProviderAuthService(
      runtime,
      (id) => saved.get(id),
      () => "test-device",
    );
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
      }),
    ).toString("base64");
    const fetch = vi.fn(async () =>
      Response.json({
        access_token: `header.${payload}.signature`,
        refresh_token: "test-refresh",
        expires_in: 3600,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const attempt = await service.start(providerId);
      const authUrl = new URL(attempt.authUrl);
      const state = authUrl.searchParams.get("state")!;
      expect(attempt.providerId).toBe(providerId);
      if (providerId === "anthropic") {
        expect(authUrl.origin).toBe("https://claude.ai");
        expect(authUrl.searchParams.get("redirect_uri")).toBe(
          "https://platform.claude.com/oauth/code/callback",
        );
        await service.complete(attempt.attemptId, `test-code#${state}`);
        expect(fetch).toHaveBeenCalledWith(
          "https://platform.claude.com/v1/oauth/token",
          expect.objectContaining({
            body: expect.stringContaining('"code":"test-code"'),
          }),
        );
      } else {
        expect(authUrl.origin).toBe("https://auth.openai.com");
        expect(authUrl.searchParams.get("codex_cli_simplified_flow")).toBe("true");
        const callback = new URL(authUrl.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "test-code");
        callback.searchParams.set("state", state);
        await service.complete(attempt.attemptId, callback.toString());
        expect(fetch).toHaveBeenCalledWith(
          "https://auth.openai.com/oauth/token",
          expect.objectContaining({
            body: expect.any(URLSearchParams),
          }),
        );
      }
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(service.getAttemptStatus(attempt.attemptId)).toEqual({
        attemptId: attempt.attemptId,
        completed: true,
      });
      const credential = await credentials.read(providerId);
      expect(credential?.type).toBe("oauth");
      saved.set(providerId, credential!);
      expect(
        service.getStatus().providers.find((provider) => provider.id === providerId),
      ).toMatchObject({ connected: true, authKind: "oauth" });
      expect(await credentials.read("openai")).toBeUndefined();
    } finally {
      await service.dispose();
      vi.unstubAllGlobals();
    }
  },
);
