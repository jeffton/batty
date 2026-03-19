import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  formatSetupCode,
  PasskeyAuthService,
  passkeyStateFilePath,
  setupCodeFilePath,
} from "@/server/passkeys";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createBattyDir(): Promise<string> {
  const battyDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-passkeys-"));
  tempDirs.push(battyDir);
  return battyDir;
}

describe("PasskeyAuthService", () => {
  it("creates a bootstrap setup code when no passkeys exist", async () => {
    const battyDir = await createBattyDir();
    const passkeys = new PasskeyAuthService(battyDir, "test-secret");

    const setup = await passkeys.initialize();
    const status = await passkeys.getStatus();

    expect(setup?.code).toMatch(/^[a-z0-9]{8}$/);
    expect(status).toEqual({
      passkeyCount: 0,
      passkeyLoginAvailable: false,
      registrationOpen: true,
      setupRequired: true,
    });

    const persisted = JSON.parse(await fs.readFile(setupCodeFilePath(battyDir), "utf8")) as {
      codeHash: string;
    };
    expect(persisted.codeHash).not.toBe(setup?.code);
  });

  it("reports registered passkeys without issuing a bootstrap code", async () => {
    const battyDir = await createBattyDir();

    await fs.mkdir(path.dirname(passkeyStateFilePath(battyDir)), { recursive: true });
    await fs.writeFile(
      passkeyStateFilePath(battyDir),
      `${JSON.stringify(
        {
          userId: "owner-id",
          username: "ignored",
          displayName: "ignored",
          credentials: [
            {
              id: "credential-1",
              publicKey: Buffer.from("public-key").toString("base64url"),
              counter: 7,
              transports: ["internal"],
              deviceType: "multiDevice",
              backedUp: true,
              createdAt: 1,
              lastUsedAt: 2,
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const passkeys = new PasskeyAuthService(battyDir, "test-secret");
    const setup = await passkeys.initialize();
    const status = await passkeys.getStatus();

    expect(setup).toBeUndefined();
    expect(status).toEqual({
      passkeyCount: 1,
      passkeyLoginAvailable: true,
      registrationOpen: false,
      setupRequired: false,
    });
  });

  it("reuses an existing valid setup code during startup", async () => {
    const battyDir = await createBattyDir();
    await fs.mkdir(path.dirname(setupCodeFilePath(battyDir)), { recursive: true });
    await fs.writeFile(
      setupCodeFilePath(battyDir),
      `${JSON.stringify(
        {
          codeHash: "existing",
          issuedAt: Date.now() - 1_000,
          expiresAt: Date.now() + 60_000,
          reason: "test",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const passkeys = new PasskeyAuthService(battyDir, "test-secret");
    const setup = await passkeys.initialize();
    const persisted = JSON.parse(await fs.readFile(setupCodeFilePath(battyDir), "utf8")) as {
      codeHash: string;
    };

    expect(setup).toBeUndefined();
    expect(persisted.codeHash).toBe("existing");
  });

  it("accepts grouped setup code input during registration", async () => {
    const battyDir = await createBattyDir();
    const passkeys = new PasskeyAuthService(battyDir, "test-secret");

    const setup = await passkeys.issueSetupCode("test");
    const registration = await passkeys.beginRegistration(
      formatSetupCode(setup.code).toUpperCase(),
      "https://batty.test",
      "batty.test",
    );

    expect(registration.requestId.length).toBeGreaterThan(0);
    expect(registration.optionsJSON.challenge.length).toBeGreaterThan(0);
  });

  it("keeps only the latest pending authentication challenge", async () => {
    const battyDir = await createBattyDir();

    await fs.mkdir(path.dirname(passkeyStateFilePath(battyDir)), { recursive: true });
    await fs.writeFile(
      passkeyStateFilePath(battyDir),
      `${JSON.stringify(
        {
          userId: "owner-id",
          username: "ignored",
          displayName: "ignored",
          credentials: [
            {
              id: "credential-1",
              publicKey: Buffer.from("public-key").toString("base64url"),
              counter: 7,
              transports: ["internal"],
              deviceType: "multiDevice",
              backedUp: true,
              createdAt: 1,
              lastUsedAt: 2,
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const passkeys = new PasskeyAuthService(battyDir, "test-secret");
    const first = await passkeys.beginAuthentication("https://batty.test", "batty.test");
    const second = await passkeys.beginAuthentication("https://batty.test", "batty.test");

    expect(second.requestId).not.toBe(first.requestId);
    expect(
      (passkeys as unknown as { pendingAuthentication?: { requestId: string } })
        .pendingAuthentication?.requestId,
    ).toBe(second.requestId);
  });

  it("drops expired setup codes from disk", async () => {
    const battyDir = await createBattyDir();
    await fs.mkdir(path.dirname(setupCodeFilePath(battyDir)), { recursive: true });
    await fs.writeFile(
      setupCodeFilePath(battyDir),
      `${JSON.stringify(
        {
          codeHash: "expired",
          issuedAt: Date.now() - 10_000,
          expiresAt: Date.now() - 1,
          reason: "test",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const passkeys = new PasskeyAuthService(battyDir, "test-secret");
    const status = await passkeys.getStatus();

    expect(status.registrationOpen).toBe(false);
    await expect(fs.access(setupCodeFilePath(battyDir))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
