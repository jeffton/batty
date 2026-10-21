import type { Credential } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderUsage, ProviderUsageUpdate, ProviderUsageWindow } from "@/shared/types";

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

interface AccountSnapshot {
  accountId?: string;
  snapshot: ProviderUsageUpdate;
}

interface CachedUsage {
  snapshot: ProviderUsageUpdate;
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

function toUsage(response: WhamUsageResponse): ProviderUsage {
  const modelWindows: Record<string, ProviderUsageWindow[]> = {};
  for (const limit of response.additional_rate_limits ?? []) {
    const model = limit.limit_name.toLowerCase();
    modelWindows[model] = [
      ...(modelWindows[model] ?? []),
      ...windowsForRateLimit(limit.rate_limit, `${limit.metered_feature}:`),
    ];
  }
  return { windows: windowsForRateLimit(response.rate_limit), modelWindows };
}

export class ProviderUsageService {
  private readonly cache = new Map<string, CachedUsage>();
  private readonly subscribers = new Set<{
    callback: (snapshot: ProviderUsageUpdate) => void;
    lastSnapshot?: string;
  }>();
  private pending?: Promise<AccountSnapshot>;
  private timer?: ReturnType<typeof setTimeout>;
  private timerAt?: number;
  private snapshot?: ProviderUsageUpdate;
  private snapshotAccount?: string;

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
    const { accountId, snapshot } = await this.reconcile();
    if (accountId !== this.accountId()) {
      return this.getUsage(provider, model);
    }
    if (snapshot.error) {
      throw new Error(snapshot.error);
    }
    const usage = snapshot.usage!;
    return {
      windows: [...usage.windows, ...(usage.modelWindows?.[model.toLowerCase()] ?? [])],
    };
  }

  subscribe(callback: (snapshot: ProviderUsageUpdate) => void): () => void {
    const subscriber: {
      callback: (snapshot: ProviderUsageUpdate) => void;
      lastSnapshot?: string;
    } = { callback };
    this.subscribers.add(subscriber);
    this.clearChangedAccount(this.accountId());
    if (this.snapshot && subscriber.lastSnapshot !== JSON.stringify(this.snapshot)) {
      subscriber.lastSnapshot = JSON.stringify(this.snapshot);
      callback(this.snapshot);
    }
    void this.reconcile();
    return () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0 && this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.timerAt = undefined;
      }
    };
  }

  private reconcile(): Promise<AccountSnapshot> {
    this.clearChangedAccount(this.accountId());
    if (!this.pending) {
      this.pending = this.readSnapshot().finally(() => {
        this.pending = undefined;
        this.scheduleRefresh();
      });
    }
    return this.pending.then((result) =>
      result.accountId === this.accountId() ? result : this.reconcile(),
    );
  }

  private scheduleRefresh(): void {
    if (this.subscribers.size === 0) {
      return;
    }
    const accountId = this.accountId();
    const expiresAt = accountId === undefined ? undefined : this.cache.get(accountId)?.expiresAt;
    if (this.timer && (expiresAt === undefined || expiresAt === this.timerAt)) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timerAt = expiresAt ?? this.now() + CACHE_TTL_MS;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.timerAt = undefined;
        void this.reconcile();
      },
      Math.max(0, this.timerAt - this.now()),
    );
  }

  private publish(snapshot: ProviderUsageUpdate, accountId: string | undefined): void {
    this.snapshot = snapshot;
    this.snapshotAccount = accountId;
    const serialized = JSON.stringify(snapshot);
    for (const subscriber of this.subscribers) {
      if (subscriber.lastSnapshot !== serialized) {
        subscriber.lastSnapshot = serialized;
        subscriber.callback(snapshot);
      }
    }
  }

  private clearChangedAccount(accountId: string | undefined): void {
    if (this.snapshot && this.snapshotAccount !== accountId) {
      this.publish({ provider: OPENAI_CODEX_PROVIDER, usage: { windows: [] } }, accountId);
    }
  }

  private accountId(): string | undefined {
    const credential = this.readCredential(OPENAI_CODEX_PROVIDER);
    return credential?.type === "oauth" && typeof credential.accountId === "string"
      ? credential.accountId
      : undefined;
  }

  private async readSnapshot(): Promise<AccountSnapshot> {
    // Authentication may complete after logout or an account switch. Never publish
    // that account's result to clients viewing the replacement account.
    for (;;) {
      const accountId = this.accountId();
      this.clearChangedAccount(accountId);
      const cached = accountId === undefined ? undefined : this.cache.get(accountId);
      const snapshot =
        accountId === undefined
          ? { provider: OPENAI_CODEX_PROVIDER, usage: { windows: [] } }
          : cached && cached.expiresAt > this.now()
            ? cached.snapshot
            : await this.refresh(accountId, cached?.snapshot.usage);
      if (accountId === this.accountId()) {
        this.publish(snapshot, accountId);
        return { accountId, snapshot };
      }
    }
  }

  private async refresh(
    accountId: string,
    lastUsage?: ProviderUsage,
  ): Promise<ProviderUsageUpdate> {
    let snapshot: ProviderUsageUpdate;
    try {
      const auth = await this.modelRuntime.getAuth(OPENAI_CODEX_PROVIDER, {
        minOAuthValidityMs: CACHE_TTL_MS,
      });
      const credential = this.readCredential(OPENAI_CODEX_PROVIDER);
      if (accountId !== this.accountId()) {
        return { provider: OPENAI_CODEX_PROVIDER, usage: { windows: [] } };
      }
      if (auth === undefined || credential?.type !== "oauth") {
        throw new Error("ChatGPT usage authentication unavailable");
      }
      const response = await this.fetchUsage(WHAM_USAGE_URL, {
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${credential.access}`,
          "chatgpt-account-id": accountId,
          originator: "pi",
        },
      });
      if (!response.ok) {
        throw new Error(`ChatGPT usage request failed: ${response.status} ${response.statusText}`);
      }
      snapshot = {
        provider: OPENAI_CODEX_PROVIDER,
        usage: toUsage((await response.json()) as WhamUsageResponse),
      };
    } catch (error) {
      snapshot = {
        provider: OPENAI_CODEX_PROVIDER,
        ...(lastUsage ? { usage: lastUsage } : {}),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.cache.set(accountId, { snapshot, expiresAt: this.now() + CACHE_TTL_MS });
    return snapshot;
  }
}
