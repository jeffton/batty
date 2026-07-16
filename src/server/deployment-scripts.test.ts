import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vite-plus/test";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createInstallFixture(pnpmExitCode: number): Promise<{
  repoDir: string;
  installRoot: string;
  oldRelease: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-install-script-"));
  tempDirs.push(root);
  const repoDir = path.join(root, "repo");
  const installRoot = path.join(root, "install");
  const oldRelease = path.join(installRoot, "releases", "test-release.old");
  const fakeBin = path.join(root, "bin");
  await Promise.all([
    fs.mkdir(path.join(repoDir, "scripts"), { recursive: true }),
    fs.mkdir(path.join(repoDir, "dist", "client"), { recursive: true }),
    fs.mkdir(path.join(repoDir, "dist", "server"), { recursive: true }),
    fs.mkdir(oldRelease, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
  ]);
  await Promise.all([
    fs.copyFile(
      path.join(process.cwd(), "scripts", "install-release.sh"),
      path.join(repoDir, "scripts", "install-release.sh"),
    ),
    fs.writeFile(path.join(repoDir, "README.md"), "fixture\n"),
    fs.writeFile(path.join(repoDir, "package.json"), "{}\n"),
    fs.writeFile(path.join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
    fs.writeFile(path.join(repoDir, "pnpm-workspace.yaml"), "catalog: {}\n"),
    fs.writeFile(path.join(repoDir, "dist", "client", "index.html"), "client\n"),
    fs.writeFile(path.join(repoDir, "dist", "server", "main.js"), "server\n"),
    fs.writeFile(path.join(oldRelease, "marker"), "old\n"),
    fs.writeFile(path.join(fakeBin, "pnpm"), `#!/usr/bin/env bash\nexit ${pnpmExitCode}\n`, {
      mode: 0o755,
    }),
  ]);
  await fs.symlink(oldRelease, path.join(installRoot, "current"));
  return {
    repoDir,
    installRoot,
    oldRelease,
    env: {
      ...process.env,
      BATTY_INSTALL_ROOT: installRoot,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
  };
}

describe("deployment scripts", () => {
  it("keeps the active Linux release when same-name staging fails", async () => {
    const fixture = await createInstallFixture(1);

    await expect(
      execFileAsync(
        "bash",
        [path.join(fixture.repoDir, "scripts", "install-release.sh"), "test-release"],
        {
          env: fixture.env,
        },
      ),
    ).rejects.toThrow();

    expect(await fs.realpath(path.join(fixture.installRoot, "current"))).toBe(fixture.oldRelease);
    await expect(fs.readFile(path.join(fixture.oldRelease, "marker"), "utf8")).resolves.toBe(
      "old\n",
    );
  });

  it("publishes a complete Linux release without deleting the previous target", async () => {
    const fixture = await createInstallFixture(0);

    await execFileAsync(
      "bash",
      [path.join(fixture.repoDir, "scripts", "install-release.sh"), "test-release"],
      {
        env: fixture.env,
      },
    );

    const current = await fs.realpath(path.join(fixture.installRoot, "current"));
    expect(current).not.toBe(fixture.oldRelease);
    await expect(
      fs.readFile(path.join(current, "dist", "client", "index.html"), "utf8"),
    ).resolves.toBe("client\n");
    await expect(fs.readFile(path.join(fixture.oldRelease, "marker"), "utf8")).resolves.toBe(
      "old\n",
    );
    await expect(fs.readFile(path.join(current, "pnpm-workspace.yaml"), "utf8")).resolves.toBe(
      "catalog: {}\n",
    );
  });

  it("packages the pnpm workspace configuration in Windows releases", async () => {
    const script = await fs.readFile(
      path.join(process.cwd(), "scripts", "install-release.ps1"),
      "utf8",
    );
    expect(script).toContain(
      'Copy-Item (Join-Path $repoDir "pnpm-workspace.yaml") (Join-Path $tmpDir "pnpm-workspace.yaml")',
    );
  });

  it("writes the plural workspace-root schema in Windows deployments", async () => {
    const script = await fs.readFile(
      path.join(process.cwd(), "scripts", "deploy-windows.ps1"),
      "utf8",
    );
    expect(script).toContain("workspacesRoots = @($WorkspacesRoot)");
    expect(script).not.toMatch(/\bworkspacesRoot\s*=/);
  });
});
