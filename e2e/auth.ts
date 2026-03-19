import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";

interface OptionsFile {
  authSecret?: string;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function createAuthToken(secret: string, ttlMs = 1000 * 60 * 60 * 24 * 30): string {
  const payload = {
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  };
  const encodedPayload = encode(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

async function readE2eAuthSecret(): Promise<string> {
  const optionsPath = path.join(process.cwd(), ".batty", "options.json");
  const options = JSON.parse(await fs.readFile(optionsPath, "utf8")) as OptionsFile;

  if (!options.authSecret) {
    throw new Error(`Missing authSecret in ${optionsPath}`);
  }

  return options.authSecret;
}

export async function authenticate(page: Page): Promise<void> {
  const authSecret = await readE2eAuthSecret();
  await page.context().addCookies([
    {
      name: "batty-auth",
      value: createAuthToken(authSecret),
      url: "http://127.0.0.1:3147",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}
