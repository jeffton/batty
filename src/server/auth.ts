import crypto from "node:crypto";

interface TokenPayload {
  issuedAt: number;
  expiresAt: number;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createAuthToken(secret: string, ttlMs = 1000 * 60 * 60 * 24 * 30): string {
  const payload: TokenPayload = {
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  };
  const encodedPayload = encode(JSON.stringify(payload));
  const signature = sign(secret, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function authCacheScope(
  secret: string,
  token: string,
): { cacheScope: string; cacheExpiresAt: number } {
  const payload = JSON.parse(decode(token.split(".")[0]!)) as TokenPayload;
  return { cacheScope: sign(secret, `local-cache:${token}`), cacheExpiresAt: payload.expiresAt };
}

export function authTokenExpiresAt(secret: string, token?: string): number | undefined {
  if (!token) return undefined;

  const [encodedPayload, providedSignature] = token.split(".");
  if (!encodedPayload || !providedSignature) return undefined;

  const expectedSignature = sign(secret, encodedPayload);
  const expected = Buffer.from(expectedSignature);
  const actual = Buffer.from(providedSignature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual))
    return undefined;

  try {
    const payload = JSON.parse(decode(encodedPayload)) as TokenPayload;
    return Number.isFinite(payload.expiresAt) && payload.expiresAt > Date.now()
      ? payload.expiresAt
      : undefined;
  } catch {
    return undefined;
  }
}

export function verifyAuthToken(secret: string, token?: string): boolean {
  return authTokenExpiresAt(secret, token) !== undefined;
}

const logoutListeners = new Map<string, Set<() => void>>();

/** Close live channels for this cookie; authentication cookies remain stateless. */
export function onAuthTokenLogout(secret: string, token: string, close: () => void): () => void {
  const key = sign(secret, `logout:${token}`);
  let listeners = logoutListeners.get(key);
  if (!listeners) logoutListeners.set(key, (listeners = new Set()));
  listeners.add(close);
  return () => {
    listeners.delete(close);
    if (!listeners.size && logoutListeners.get(key) === listeners) logoutListeners.delete(key);
  };
}

export function notifyAuthTokenLogout(secret: string, token?: string): void {
  if (!token) return;
  const key = sign(secret, `logout:${token}`);
  const listeners = logoutListeners.get(key);
  logoutListeners.delete(key);
  for (const close of listeners ?? []) close();
}
