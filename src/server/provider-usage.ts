import type { Credential } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderUsage, ProviderUsageWindow } from "@/shared/types";

const CACHE_TTL_MS = 60_000;
const OPENAI_CODEX_PROVIDER = "openai-codex";
const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

interface WhamUsageWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_at: number;
}

interface WhamRateLimit {
  primary_window?: WhamUsageWindow;
  secondary_window?: WhamUsageWindow;
}

interface WhamAdditionalRateLimit {
  limit_name: string;
  metered_feature: string;
  rate_limit?: WhamRateLimit;
}

interface WhamUsageResponse {
  rate_limit?: WhamRateLimit;
  additional_rate_limits?: WhamAdditionalRateLimit[];
}

interface CachedUsage {
  response: WhamUsageResponse;
  expiresAt: number;
}

function toUsageWindow(id: string, window: WhamUsageWindow): ProviderUsageWindow {
  return {
    id,
    usedPercent: window.used_percent,
    windowSeconds: window.limit_window_seconds,
    resetsAt: window.reset_at * 1000,
  };
}

function windowsForRateLimit(
  rateLimit: WhamRateLimit | undefined,
  prefix = "",
): ProviderUsageWindow[] {
  return [
    ...(rateLimit?.primary_window
      ? [toUsageWindow(`${prefix}primary`, rateLimit.primary_window)]
      : []),
    ...(rateLimit?.secondary_window
      ? [toUsageWindow(`${prefix}secondary`, rateLimit.secondary_window)]
      : []),
  ];
}

export class ProviderUsageService {
  private readonly cache = new Map<string, CachedUsage>();
  private readonly requests = new Map<string, Promise<WhamUsageResponse>>();

  constructor(
    private readonly modelRuntime: Pick<ModelRuntime, "getAuth">,
    private readonly readCredential: (providerId: string) => Credential | undefined,
    private readonly fetchUsage: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getUsage(provider: string, model: string): Promise<ProviderUsage> {
    if (provider !== OPENAI_CODEX_PROVIDER) {
      return { windows: [] };
    }

    const auth = await this.modelRuntime.getAuth(OPENAI_CODEX_PROVIDER, {
      minOAuthValidityMs: CACHE_TTL_MS,
    });
    const credential = this.readCredential(OPENAI_CODEX_PROVIDER);
    if (
      auth === undefined ||
      credential?.type !== "oauth" ||
      typeof credential.accountId !== "string" ||
      typeof credential.access !== "string"
    ) {
      return { windows: [] };
    }

    const { access, accountId } = credential;
    const key = `${provider}/${accountId}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return this.toUsage(cached.response, model);
    }

    const request = this.requests.get(key);
    if (request) {
      return this.toUsage(await request, model);
    }

    const pending = this.fetchAndCache(key, { access, accountId });
    this.requests.set(key, pending);
    try {
      return this.toUsage(await pending, model);
    } finally {
      this.requests.delete(key);
    }
  }

  private async fetchAndCache(key: string, credential: { access: string; accountId: string }) {
    const response = await this.fetchUsage(WHAM_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credential.access}`,
        "chatgpt-account-id": credential.accountId,
        originator: "pi",
      },
    });
    if (!response.ok) {
      throw new Error(`ChatGPT usage request failed: ${response.status} ${response.statusText}`);
    }

    const usage = (await response.json()) as WhamUsageResponse;
    this.cache.set(key, { response: usage, expiresAt: this.now() + CACHE_TTL_MS });
    return usage;
  }

  private toUsage(response: WhamUsageResponse, model: string): ProviderUsage {
    const additionalWindows = (response.additional_rate_limits ?? [])
      .filter((limit) => limit.limit_name.toLowerCase() === model.toLowerCase())
      .flatMap((limit) => windowsForRateLimit(limit.rate_limit, `${limit.metered_feature}:`));
    return {
      windows: [...windowsForRateLimit(response.rate_limit), ...additionalWindows],
    };
  }
}
