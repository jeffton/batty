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

export function verifyAuthToken(secret: string, token?: string): boolean {
  if (!token) {
    return false;
  }

  const [encodedPayload, providedSignature] = token.split(".");
  if (!encodedPayload || !providedSignature) {
    return false;
  }

  const expectedSignature = sign(secret, encodedPayload);
  const expected = Buffer.from(expectedSignature);
  const actual = Buffer.from(providedSignature);

  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return false;
  }

  try {
    const payload = JSON.parse(decode(encodedPayload)) as TokenPayload;
    return payload.expiresAt > Date.now();
  } catch {
    return false;
  }
}
