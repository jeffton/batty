import { describe, expect, it, vi } from "vite-plus/test";
import type { Credential } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ProviderUsageService } from "./provider-usage";

const freshCredential: Credential = {
  type: "oauth",
  access: "refreshed-access-token",
  refresh: "refresh-token",
  expires: Date.now() + 3_600_000,
  accountId: "account-id",
};

function usageResponse(additionalRateLimits: object[] = []) {
  return new Response(
    JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18_000,
          reset_at: 1_700_000_000,
        },
        secondary_window: {
          used_percent: 75,
          limit_window_seconds: 604_800,
          reset_at: 1_700_100_000,
        },
      },
      additional_rate_limits: additionalRateLimits,
    }),
  );
}

const sparkRateLimit = {
  limit_name: "gpt-5.3-codex-spark",
  metered_feature: "codex_spark",
  rate_limit: {
    primary_window: {
      used_percent: 10,
      limit_window_seconds: 300,
      reset_at: 1_700_200_000,
    },
  },
};

function createService(
  options: {
    credential?: Credential;
    fetchUsage?: typeof fetch;
    now?: () => number;
  } = {},
) {
  const modelRuntime = {
    getAuth: vi.fn(async () => freshCredential),
  } as unknown as Pick<ModelRuntime, "getAuth">;
  const service = new ProviderUsageService(
    modelRuntime,
    () => ("credential" in options ? options.credential : freshCredential),
    options.fetchUsage ?? vi.fn(async () => usageResponse()),
    options.now,
  );
  return { service, modelRuntime };
}

describe("ProviderUsageService", () => {
  it("uses the refreshed stored OAuth credential and maps the base quota windows", async () => {
    const fetchUsage = vi.fn(async () => usageResponse());
    const { service, modelRuntime } = createService({ fetchUsage });

    await expect(service.getUsage("openai-codex", "gpt-5.6-terra")).resolves.toEqual({
      windows: [
        { id: "primary", usedPercent: 25, windowSeconds: 18_000, resetsAt: 1_700_000_000_000 },
        { id: "secondary", usedPercent: 75, windowSeconds: 604_800, resetsAt: 1_700_100_000_000 },
      ],
    });
    expect(modelRuntime.getAuth).toHaveBeenCalledWith("openai-codex", {
      minOAuthValidityMs: 60_000,
    });
    expect(fetchUsage).toHaveBeenCalledWith("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: "Bearer refreshed-access-token",
        "chatgpt-account-id": "account-id",
        originator: "pi",
      },
    });
  });

  it("includes an additional quota only when its limit_name exactly matches the model", async () => {
    const { service } = createService({
      fetchUsage: vi.fn(async () => usageResponse([sparkRateLimit])),
    });

    await expect(service.getUsage("openai-codex", "GPT-5.3-CODEX-SPARK")).resolves.toEqual({
      windows: [
        { id: "primary", usedPercent: 25, windowSeconds: 18_000, resetsAt: 1_700_000_000_000 },
        { id: "secondary", usedPercent: 75, windowSeconds: 604_800, resetsAt: 1_700_100_000_000 },
        {
          id: "codex_spark:primary",
          usedPercent: 10,
          windowSeconds: 300,
          resetsAt: 1_700_200_000_000,
        },
      ],
    });
  });

  it("keeps the base quota for normal models and does not fuzzy-match additional quotas", async () => {
    const { service } = createService({
      fetchUsage: vi.fn(async () => usageResponse([sparkRateLimit])),
    });

    await expect(service.getUsage("openai-codex", "gpt-5.6-terra-spark")).resolves.toEqual({
      windows: [
        { id: "primary", usedPercent: 25, windowSeconds: 18_000, resetsAt: 1_700_000_000_000 },
        { id: "secondary", usedPercent: 75, windowSeconds: 604_800, resetsAt: 1_700_100_000_000 },
      ],
    });
  });

  it("returns no windows when the provider is unsupported or OAuth credentials are unavailable", async () => {
    const fetchUsage = vi.fn();
    const unsupported = createService({ fetchUsage });
    const unavailable = createService({ credential: undefined, fetchUsage });

    await expect(unsupported.service.getUsage("openrouter", "model")).resolves.toEqual({
      windows: [],
    });
    await expect(unavailable.service.getUsage("openai-codex", "model")).resolves.toEqual({
      windows: [],
    });
    expect(fetchUsage).not.toHaveBeenCalled();
  });

  it("deduplicates in-flight requests and caches raw usage per provider/account across models", async () => {
    let now = 1_000_000;
    let resolveResponse!: (response: Response) => void;
    const fetchUsage = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const { service } = createService({ fetchUsage, now: () => now });

    const normal = service.getUsage("openai-codex", "gpt-5.6-terra");
    const spark = service.getUsage("openai-codex", "gpt-5.3-codex-spark");
    await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
    resolveResponse(usageResponse([sparkRateLimit]));
    const [normalUsage, sparkUsage] = await Promise.all([normal, spark]);
    expect(normalUsage.windows.map((window) => window.id)).toEqual(["primary", "secondary"]);
    expect(sparkUsage.windows.map((window) => window.id)).toEqual([
      "primary",
      "secondary",
      "codex_spark:primary",
    ]);

    fetchUsage.mockResolvedValue(usageResponse([sparkRateLimit]));
    await service.getUsage("openai-codex", "gpt-5.3-codex-spark");
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    now += 60_000;
    await service.getUsage("openai-codex", "gpt-5.3-codex-spark");
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("does not share cached raw usage between accounts", async () => {
    let credential = freshCredential;
    const modelRuntime = {
      getAuth: vi.fn(async () => freshCredential),
    } as unknown as Pick<ModelRuntime, "getAuth">;
    const fetchUsage = vi.fn(async () => usageResponse());
    const service = new ProviderUsageService(modelRuntime, () => credential, fetchUsage);

    await service.getUsage("openai-codex", "gpt-5.6-terra");
    credential = { ...freshCredential, accountId: "another-account-id" };
    await service.getUsage("openai-codex", "gpt-5.6-terra");

    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("does not hide usage request failures", async () => {
    const fetchUsage = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const { service } = createService({ fetchUsage });

    await expect(service.getUsage("openai-codex", "gpt-5.6-terra")).rejects.toThrow(
      "ChatGPT usage request failed: 503",
    );
  });
});
