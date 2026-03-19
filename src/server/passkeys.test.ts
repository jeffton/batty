import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { PasskeyAuthService, passkeyStateFilePath, setupCodeFilePath } from "@/server/passkeys";

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

    expect(setup?.code).toMatch(/^\d{6}$/);
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
