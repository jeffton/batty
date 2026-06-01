import { randomUUID } from "node:crypto";
import { OPENAI_CODEX_BROWSER_LOGIN_METHOD } from "@earendil-works/pi-ai/oauth";
import type { ApiKeyCredential, AuthStorage } from "@earendil-works/pi-coding-agent";
import type {
  ProviderAuthProviderStatus,
  ProviderAuthStartResponse,
  ProviderAuthStatus,
} from "@/shared/types";

const PROVIDER_AUTH_TTL_MS = 10 * 60 * 1000;
const API_KEY_PROVIDER_NAMES = {
  google: "Gemini",
  openrouter: "OpenRouter",
} as const;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

interface ProviderAuthAttempt {
  id: string;
  providerId: string;
  authUrl: string;
  instructions?: string;
  createdAt: number;
  expiresAt: number;
  completed: boolean;
  finalError?: Error;
  manualInput: Deferred<string>;
  loginPromise: Promise<void>;
  timeout: NodeJS.Timeout;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) {
      return undefined;
    }
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function statusForProvider(
  authStorage: AuthStorage,
  providerId: string,
  name: string,
): ProviderAuthProviderStatus {
  const credential = authStorage.get(providerId);
  const payload = credential?.type === "oauth" ? decodeJwtPayload(credential.access) : undefined;
  const profile =
    payload?.["https://api.openai.com/profile"] &&
    typeof payload["https://api.openai.com/profile"] === "object"
      ? (payload["https://api.openai.com/profile"] as Record<string, unknown>)
      : undefined;
  const connectedEmail =
    typeof profile?.email === "string"
      ? profile.email
      : typeof payload?.email === "string"
        ? payload.email
        : typeof payload?.preferred_username === "string"
          ? payload.preferred_username
          : undefined;

  return {
    id: providerId,
    name,
    connected: credential?.type === "oauth" || credential?.type === "api_key",
    ...(credential?.type === "oauth" ? { authKind: "oauth" as const } : {}),
    ...(credential?.type === "api_key" ? { authKind: "apiKey" as const } : {}),
    ...(connectedEmail ? { connectedEmail } : {}),
  };
}

export class ProviderAuthService {
  private readonly attempts = new Map<string, ProviderAuthAttempt>();

  constructor(private readonly authStorage: AuthStorage) {}

  getStatus(): ProviderAuthStatus {
    this.cleanupExpiredAttempts();
    const oauthProviders = this.authStorage
      .getOAuthProviders()
      .filter((provider) => provider.id === "openai-codex")
      .map((provider) => statusForProvider(this.authStorage, provider.id, provider.name));
    const apiKeyProviders = Object.entries(API_KEY_PROVIDER_NAMES).map(([providerId, name]) =>
      statusForProvider(this.authStorage, providerId, name),
    );

    return {
      providers: [...oauthProviders, ...apiKeyProviders].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    };
  }

  setApiKey(providerId: keyof typeof API_KEY_PROVIDER_NAMES, apiKey: string): ProviderAuthStatus {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("Missing API key");
    }

    const credential: ApiKeyCredential = {
      type: "api_key",
      key: trimmed,
    };
    this.authStorage.set(providerId, credential);
    return this.getStatus();
  }

  async start(providerId: "openai-codex"): Promise<ProviderAuthStartResponse> {
    this.cleanupExpiredAttempts();

    const attemptId = randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + PROVIDER_AUTH_TTL_MS;
    const authInfo = deferred<{ url: string; instructions?: string }>();
    const manualInput = deferred<string>();

    const timeout = setTimeout(() => {
      const attempt = this.attempts.get(attemptId);
      if (!attempt || attempt.completed) {
        return;
      }
      const error = new Error("Auth attempt expired");
      attempt.finalError = error;
      manualInput.reject(error);
    }, PROVIDER_AUTH_TTL_MS);

    const loginPromise = this.authStorage
      .login(providerId, {
        onAuth: (info) => {
          authInfo.resolve(info);
        },
        onDeviceCode: (info) => {
          authInfo.resolve({
            url: info.verificationUri,
            instructions: `Enter code: ${info.userCode}`,
          });
        },
        onPrompt: async () => manualInput.promise,
        onManualCodeInput: async () => manualInput.promise,
        onSelect: async () => OPENAI_CODEX_BROWSER_LOGIN_METHOD,
      })
      .then(() => {
        const attempt = this.attempts.get(attemptId);
        if (attempt) {
          attempt.completed = true;
          clearTimeout(attempt.timeout);
        }
      })
      .catch((error) => {
        const attempt = this.attempts.get(attemptId);
        const normalized = normalizeError(error);
        if (attempt) {
          attempt.finalError = normalized;
          clearTimeout(attempt.timeout);
        }
      });

    this.attempts.set(attemptId, {
      id: attemptId,
      providerId,
      authUrl: "",
      createdAt,
      expiresAt,
      completed: false,
      manualInput,
      loginPromise,
      timeout,
    });

    try {
      const info = await authInfo.promise;
      const attempt = this.requireAttempt(attemptId);
      attempt.authUrl = info.url;
      attempt.instructions = info.instructions;
      return {
        attemptId,
        providerId,
        authUrl: info.url,
        instructions: info.instructions,
        expiresAt,
      };
    } catch (error) {
      this.attempts.delete(attemptId);
      clearTimeout(timeout);
      throw normalizeError(error);
    }
  }

  async complete(attemptId: string, callbackUrlOrCode: string): Promise<void> {
    this.cleanupExpiredAttempts();
    const attempt = this.requireAttempt(attemptId);

    if (Date.now() > attempt.expiresAt) {
      const error = new Error("Auth attempt expired");
      attempt.finalError = error;
      throw error;
    }

    if (attempt.completed) {
      return;
    }

    if (!callbackUrlOrCode.trim()) {
      throw new Error("Missing callback URL or authorization code");
    }

    attempt.manualInput.resolve(callbackUrlOrCode.trim());
    try {
      await attempt.loginPromise;
      if (attempt.finalError) {
        throw attempt.finalError;
      }
    } finally {
      clearTimeout(attempt.timeout);
      this.attempts.delete(attemptId);
    }
  }

  private requireAttempt(attemptId: string): ProviderAuthAttempt {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw new Error("Unknown auth attempt");
    }
    if (attempt.finalError) {
      throw attempt.finalError;
    }
    return attempt;
  }

  private cleanupExpiredAttempts(): void {
    const now = Date.now();
    for (const [attemptId, attempt] of this.attempts) {
      if (attempt.completed) {
        this.attempts.delete(attemptId);
        clearTimeout(attempt.timeout);
        continue;
      }
      if (now <= attempt.expiresAt || attempt.finalError) {
        continue;
      }
      const error = new Error("Auth attempt expired");
      attempt.finalError = error;
      attempt.manualInput.reject(error);
      clearTimeout(attempt.timeout);
    }
  }
}
