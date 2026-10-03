import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt, Credential } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
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
  expiresAt: number;
  completed: boolean;
  finalError?: Error;
  manualInput: Deferred<string>;
  loginPromise: Promise<void>;
  timeout: NodeJS.Timeout;
  abort: AbortController;
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
  readCredential: (providerId: string) => Credential | undefined,
  providerId: string,
  name: string,
): ProviderAuthProviderStatus {
  const credential = readCredential(providerId);
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
  private startQueue = Promise.resolve();

  constructor(
    private readonly modelRuntime: Pick<ModelRuntime, "login">,
    private readonly readCredential: (providerId: string) => Credential | undefined,
    private readonly getDeviceId: () => string | Promise<string>,
  ) {}

  getStatus(): ProviderAuthStatus {
    this.cleanupExpiredAttempts();
    const providers = [
      statusForProvider(this.readCredential, "openai", "ChatGPT subscription"),
      ...Object.entries(API_KEY_PROVIDER_NAMES).map(([providerId, name]) =>
        statusForProvider(this.readCredential, providerId, name),
      ),
    ];

    return {
      providers: providers.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async setApiKey(
    providerId: keyof typeof API_KEY_PROVIDER_NAMES,
    apiKey: string,
  ): Promise<ProviderAuthStatus> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("Missing API key");
    }

    await this.modelRuntime.login(providerId, "api_key", {
      prompt: async () => trimmed,
      notify: () => {},
    });
    return this.getStatus();
  }

  async dispose(): Promise<void> {
    const attempts = [...this.attempts.values()];
    for (const attempt of attempts) {
      clearTimeout(attempt.timeout);
      if (!attempt.completed && !attempt.finalError) {
        const error = new Error("Auth attempt cancelled");
        attempt.manualInput.reject(error);
        attempt.abort.abort(error);
      }
    }
    await Promise.all(attempts.map((attempt) => attempt.loginPromise));
    this.attempts.clear();
  }

  getAttemptStatus(attemptId: string): { completed: boolean } {
    this.cleanupExpiredAttempts();
    return { completed: this.requireAttempt(attemptId).completed };
  }

  start(providerId: "openai"): Promise<ProviderAuthStartResponse> {
    const started = this.startQueue.then(() => this.startAttempt(providerId));
    this.startQueue = started.then(
      () => {},
      () => {},
    );
    return started;
  }

  private async startAttempt(providerId: "openai"): Promise<ProviderAuthStartResponse> {
    this.cleanupExpiredAttempts();
    const deviceId = await this.getDeviceId();
    await this.dispose();

    const attemptId = randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + PROVIDER_AUTH_TTL_MS;
    const authInfo = deferred<{ url: string; instructions?: string }>();
    const manualInput = deferred<string>();
    const abort = new AbortController();

    const timeout = setTimeout(() => {
      const attempt = this.attempts.get(attemptId);
      if (!attempt || attempt.completed) {
        return;
      }
      const error = new Error("Auth attempt expired");
      attempt.finalError = error;
      authInfo.reject(error);
      manualInput.reject(error);
      abort.abort(error);
    }, PROVIDER_AUTH_TTL_MS);

    const notify = (event: AuthEvent): void => {
      if (event.type === "auth_url") {
        authInfo.resolve({ url: event.url, instructions: event.instructions });
      } else if (event.type === "device_code") {
        authInfo.resolve({
          url: event.verificationUri,
          instructions: `Enter code: ${event.userCode}`,
        });
      }
    };
    const prompt = async (request: AuthPrompt): Promise<string> =>
      request.type === "select" ? "browser" : manualInput.promise;

    const loginPromise = this.modelRuntime
      .login(
        providerId,
        "oauth",
        { notify, prompt, signal: abort.signal },
        { getDeviceId: () => deviceId },
      )
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
        authInfo.reject(normalized);
        if (attempt) {
          attempt.finalError = normalized;
          clearTimeout(attempt.timeout);
        }
      });

    this.attempts.set(attemptId, {
      expiresAt,
      completed: false,
      manualInput,
      loginPromise,
      timeout,
      abort,
    });

    try {
      const info = await authInfo.promise;
      this.requireAttempt(attemptId);
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

  async complete(attemptId: string, callbackUrl: string): Promise<void> {
    this.cleanupExpiredAttempts();
    const attempt = this.requireAttempt(attemptId);

    if (attempt.completed) {
      this.attempts.delete(attemptId);
      return;
    }

    if (!callbackUrl.trim()) {
      throw new Error("Missing callback URL");
    }

    attempt.manualInput.resolve(callbackUrl.trim());
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
      if (attempt.completed && now > attempt.expiresAt) {
        this.attempts.delete(attemptId);
        continue;
      }
      if (now <= attempt.expiresAt || attempt.finalError || attempt.completed) {
        continue;
      }
      const error = new Error("Auth attempt expired");
      attempt.finalError = error;
      attempt.manualInput.reject(error);
      clearTimeout(attempt.timeout);
    }
  }
}
