import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  WebAuthnCredential,
  RegistrationResponseJSON,
} from "@simplewebauthn/types";
import { stateDirPath } from "./options";

export interface StoredPasskeyCredential {
  id: string;
  publicKey: string;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number;
}

interface StoredPasskeyState {
  userId: string;
  username: string;
  displayName: string;
  credentials: StoredPasskeyCredential[];
}

interface StoredSetupCode {
  codeHash: string;
  issuedAt: number;
  expiresAt: number;
  reason: string;
}

interface PendingRegistration {
  requestId: string;
  challenge: string;
  setupCodeHash: string;
  origin: string;
  rpID: string;
  expiresAt: number;
}

interface PendingAuthentication {
  requestId: string;
  challenge: string;
  origin: string;
  rpID: string;
  expiresAt: number;
}

export interface PasskeyAuthStatus {
  passkeyCount: number;
  passkeyLoginAvailable: boolean;
  registrationOpen: boolean;
  setupRequired: boolean;
}

export interface SetupCodeResult {
  code: string;
  expiresAt: number;
}

export interface RegistrationOptionsResult {
  requestId: string;
  optionsJSON: PublicKeyCredentialCreationOptionsJSON;
}

export interface AuthenticationOptionsResult {
  requestId: string;
  optionsJSON: PublicKeyCredentialRequestOptionsJSON;
}

const SETUP_CODE_TTL_MS = 1000 * 60 * 10;
const REQUEST_TTL_MS = 1000 * 60 * 5;
const DEFAULT_USERNAME = "owner";
const DEFAULT_DISPLAY_NAME = "Batty";

export function passkeyStateFilePath(battyDir: string): string {
  return path.join(stateDirPath(battyDir), "passkeys.json");
}

export function setupCodeFilePath(battyDir: string): string {
  return path.join(stateDirPath(battyDir), "setup-code.json");
}

function createUserId(): string {
  return crypto.randomUUID();
}

function createSetupCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function hashSetupCode(secret: string, code: string): string {
  return crypto.createHash("sha256").update(secret).update(":").update(code).digest("base64url");
}

function sameValue(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isTransportList(value: unknown): value is AuthenticatorTransportFuture[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry === "ble" ||
        entry === "cable" ||
        entry === "hybrid" ||
        entry === "internal" ||
        entry === "nfc" ||
        entry === "smart-card" ||
        entry === "usb",
    )
  );
}

function normalizeCredential(value: unknown): StoredPasskeyCredential | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<StoredPasskeyCredential>;
  if (
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    typeof candidate.publicKey !== "string" ||
    candidate.publicKey.length === 0 ||
    typeof candidate.counter !== "number" ||
    !Number.isFinite(candidate.counter) ||
    (candidate.deviceType !== "singleDevice" && candidate.deviceType !== "multiDevice") ||
    typeof candidate.backedUp !== "boolean" ||
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt) ||
    typeof candidate.lastUsedAt !== "number" ||
    !Number.isFinite(candidate.lastUsedAt)
  ) {
    return undefined;
  }

  return {
    id: candidate.id,
    publicKey: candidate.publicKey,
    counter: candidate.counter,
    transports: isTransportList(candidate.transports) ? candidate.transports : undefined,
    deviceType: candidate.deviceType,
    backedUp: candidate.backedUp,
    createdAt: candidate.createdAt,
    lastUsedAt: candidate.lastUsedAt,
  };
}

function normalizePasskeyState(value: unknown): StoredPasskeyState {
  const candidate =
    value && typeof value === "object" ? (value as Partial<StoredPasskeyState>) : {};
  const credentials = Array.isArray(candidate.credentials)
    ? candidate.credentials
        .map(normalizeCredential)
        .filter((entry): entry is StoredPasskeyCredential => Boolean(entry))
    : [];

  return {
    userId:
      typeof candidate.userId === "string" && candidate.userId.length > 0
        ? candidate.userId
        : createUserId(),
    username: DEFAULT_USERNAME,
    displayName: DEFAULT_DISPLAY_NAME,
    credentials,
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export class PasskeyAuthService {
  private readonly pendingRegistrations = new Map<string, PendingRegistration>();
  private readonly pendingAuthentications = new Map<string, PendingAuthentication>();

  constructor(
    private readonly battyDir: string,
    private readonly authSecret: string,
  ) {}

  async initialize(): Promise<SetupCodeResult | undefined> {
    const state = await this.readState();
    if (state.credentials.length > 0) {
      return undefined;
    }

    return this.issueSetupCode("bootstrap");
  }

  async issueSetupCode(reason: string, ttlMs = SETUP_CODE_TTL_MS): Promise<SetupCodeResult> {
    const code = createSetupCode();
    const expiresAt = Date.now() + ttlMs;
    await writeJsonFile(setupCodeFilePath(this.battyDir), {
      codeHash: hashSetupCode(this.authSecret, code),
      issuedAt: Date.now(),
      expiresAt,
      reason,
    } satisfies StoredSetupCode);
    return { code, expiresAt };
  }

  async getStatus(): Promise<PasskeyAuthStatus> {
    const state = await this.readState();
    const setupCode = await this.readSetupCode();
    return {
      passkeyCount: state.credentials.length,
      passkeyLoginAvailable: state.credentials.length > 0,
      registrationOpen: Boolean(setupCode),
      setupRequired: state.credentials.length === 0,
    };
  }

  async beginRegistration(
    setupCode: string,
    origin: string,
    rpID: string,
  ): Promise<RegistrationOptionsResult> {
    this.prunePendingRequests();
    const storedSetupCode = await this.requireValidSetupCode(setupCode);
    const state = await this.readState();
    const optionsJSON = await generateRegistrationOptions({
      rpName: DEFAULT_DISPLAY_NAME,
      rpID,
      userName: state.username,
      userID: Buffer.from(state.userId, "utf8"),
      userDisplayName: state.displayName,
      attestationType: "none",
      excludeCredentials: state.credentials.map((credential) => ({
        id: credential.id,
        transports: credential.transports,
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      preferredAuthenticatorType: "localDevice",
    });

    const requestId = crypto.randomUUID();
    this.pendingRegistrations.set(requestId, {
      requestId,
      challenge: optionsJSON.challenge,
      setupCodeHash: storedSetupCode.codeHash,
      origin,
      rpID,
      expiresAt: Date.now() + REQUEST_TTL_MS,
    });

    return { requestId, optionsJSON };
  }

  async finishRegistration(
    requestId: string,
    response: RegistrationResponseJSON,
    origin: string,
    rpID: string,
  ): Promise<void> {
    this.prunePendingRequests();
    const pending = this.pendingRegistrations.get(requestId);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pendingRegistrations.delete(requestId);
      throw new Error("Passkey registration expired. Start again.");
    }
    if (pending.origin !== origin || pending.rpID !== rpID) {
      this.pendingRegistrations.delete(requestId);
      throw new Error("Passkey registration origin changed. Start again.");
    }

    const setupCode = await this.readSetupCode();
    if (!setupCode || !sameValue(setupCode.codeHash, pending.setupCodeHash)) {
      this.pendingRegistrations.delete(requestId);
      throw new Error("Setup code expired. Generate a new one.");
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    this.pendingRegistrations.delete(requestId);

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error("Passkey registration failed");
    }

    const credential = verification.registrationInfo.credential;
    const now = Date.now();
    const nextCredential: StoredPasskeyCredential = {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: credential.transports,
      deviceType: verification.registrationInfo.credentialDeviceType,
      backedUp: verification.registrationInfo.credentialBackedUp,
      createdAt: now,
      lastUsedAt: now,
    };

    const state = await this.readState();
    const credentials = state.credentials.filter((candidate) => candidate.id !== nextCredential.id);
    credentials.push(nextCredential);
    await this.writeState({ ...state, credentials });
    await this.clearSetupCode();
    this.clearPendingRegistrationsForSetupCode(setupCode.codeHash);
  }

  async beginAuthentication(origin: string, rpID: string): Promise<AuthenticationOptionsResult> {
    this.prunePendingRequests();
    const state = await this.readState();
    if (state.credentials.length === 0) {
      throw new Error("No passkeys registered yet. Use the setup code first.");
    }

    const optionsJSON = await generateAuthenticationOptions({
      rpID,
      allowCredentials: state.credentials.map((credential) => ({
        id: credential.id,
        transports: credential.transports,
      })),
      userVerification: "required",
    });

    const requestId = crypto.randomUUID();
    this.pendingAuthentications.set(requestId, {
      requestId,
      challenge: optionsJSON.challenge,
      origin,
      rpID,
      expiresAt: Date.now() + REQUEST_TTL_MS,
    });

    return { requestId, optionsJSON };
  }

  async finishAuthentication(
    requestId: string,
    response: AuthenticationResponseJSON,
    origin: string,
    rpID: string,
  ): Promise<void> {
    this.prunePendingRequests();
    const pending = this.pendingAuthentications.get(requestId);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pendingAuthentications.delete(requestId);
      throw new Error("Passkey sign-in expired. Start again.");
    }
    if (pending.origin !== origin || pending.rpID !== rpID) {
      this.pendingAuthentications.delete(requestId);
      throw new Error("Passkey sign-in origin changed. Start again.");
    }

    const state = await this.readState();
    const matchedCredential = state.credentials.find((credential) => credential.id === response.id);
    if (!matchedCredential) {
      this.pendingAuthentications.delete(requestId);
      throw new Error("Unknown passkey");
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: this.toWebAuthnCredential(matchedCredential),
    });
    this.pendingAuthentications.delete(requestId);

    if (!verification.verified) {
      throw new Error("Passkey sign-in failed");
    }

    const now = Date.now();
    const credentials = state.credentials.map((credential) =>
      credential.id === matchedCredential.id
        ? {
            ...credential,
            counter: verification.authenticationInfo.newCounter,
            deviceType: verification.authenticationInfo.credentialDeviceType,
            backedUp: verification.authenticationInfo.credentialBackedUp,
            lastUsedAt: now,
          }
        : credential,
    );
    await this.writeState({ ...state, credentials });
  }

  private async readState(): Promise<StoredPasskeyState> {
    const filePath = passkeyStateFilePath(this.battyDir);
    const stored = await readJsonFile<StoredPasskeyState>(filePath);
    const normalized = normalizePasskeyState(stored);
    if (JSON.stringify(stored) !== JSON.stringify(normalized)) {
      await writeJsonFile(filePath, normalized);
    }
    return normalized;
  }

  private async writeState(state: StoredPasskeyState): Promise<void> {
    await writeJsonFile(passkeyStateFilePath(this.battyDir), state);
  }

  private async readSetupCode(): Promise<StoredSetupCode | undefined> {
    const filePath = setupCodeFilePath(this.battyDir);
    const stored = await readJsonFile<StoredSetupCode>(filePath);
    if (!stored) {
      return undefined;
    }
    if (
      typeof stored.codeHash !== "string" ||
      stored.codeHash.length === 0 ||
      typeof stored.issuedAt !== "number" ||
      !Number.isFinite(stored.issuedAt) ||
      typeof stored.expiresAt !== "number" ||
      !Number.isFinite(stored.expiresAt) ||
      stored.expiresAt <= Date.now()
    ) {
      await fs.rm(filePath, { force: true });
      return undefined;
    }
    return stored;
  }

  private async requireValidSetupCode(setupCode: string): Promise<StoredSetupCode> {
    const stored = await this.readSetupCode();
    if (!stored || !sameValue(stored.codeHash, hashSetupCode(this.authSecret, setupCode.trim()))) {
      throw new Error("Wrong or expired setup code");
    }
    return stored;
  }

  private async clearSetupCode(): Promise<void> {
    await fs.rm(setupCodeFilePath(this.battyDir), { force: true });
  }

  private clearPendingRegistrationsForSetupCode(setupCodeHash: string): void {
    for (const [requestId, pending] of this.pendingRegistrations) {
      if (sameValue(pending.setupCodeHash, setupCodeHash)) {
        this.pendingRegistrations.delete(requestId);
      }
    }
  }

  private prunePendingRequests(): void {
    const now = Date.now();
    for (const [requestId, pending] of this.pendingRegistrations) {
      if (pending.expiresAt <= now) {
        this.pendingRegistrations.delete(requestId);
      }
    }
    for (const [requestId, pending] of this.pendingAuthentications) {
      if (pending.expiresAt <= now) {
        this.pendingAuthentications.delete(requestId);
      }
    }
  }

  private toWebAuthnCredential(credential: StoredPasskeyCredential): WebAuthnCredential {
    return {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey, "base64url"),
      counter: credential.counter,
      transports: credential.transports,
    };
  }
}
