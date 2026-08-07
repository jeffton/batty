import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vite-plus/test";

const execFileAsync = promisify(execFile);
const linuxIt = process.platform === "win32" ? it.skip : it;
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
    fs.mkdir(path.join(repoDir, "patches"), { recursive: true }),
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
    fs.writeFile(path.join(repoDir, "patches", "dependency.patch"), "patch\n"),
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
  linuxIt("keeps the active Linux release when same-name staging fails", async () => {
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

    expect(await fs.realpath(path.join(fixture.installRoot, "current"))).toBe(
      await fs.realpath(fixture.oldRelease),
    );
    await expect(fs.readFile(path.join(fixture.oldRelease, "marker"), "utf8")).resolves.toBe(
      "old\n",
    );
  });

  linuxIt("publishes a complete Linux release without deleting the previous target", async () => {
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
    await expect(
      fs.readFile(path.join(current, "patches", "dependency.patch"), "utf8"),
    ).resolves.toBe("patch\n");
  });

  it("installs macOS deployments as a user launch agent with a delayed upgrade reload", async () => {
    const [deployScript, handoffScript, restartScript] = await Promise.all([
      fs.readFile(path.join(process.cwd(), "scripts", "deploy-macos.sh"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "handoff-restart-macos.sh"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "restart-services-macos.sh"), "utf8"),
    ]);

    expect(deployScript).toContain('label="se.roybot.batty"');
    expect(deployScript).toContain('if [[ "$(id -u)" -eq 0 ]]');
    expect(deployScript).toContain('webPushSubject: "mailto:batty@localhost"');
    expect(deployScript).toContain('if [[ "$was_running" == true ]]');
    expect(handoffScript).toContain('sleep "$1"');
    expect(restartScript).toContain('launchctl bootstrap "$domain" "$plist"');
  });

  it("packages the pnpm workspace configuration in Windows releases", async () => {
    const script = await fs.readFile(
      path.join(process.cwd(), "scripts", "install-release.ps1"),
      "utf8",
    );
    expect(script).toContain(
      'Copy-Item (Join-Path $repoDir "pnpm-workspace.yaml") (Join-Path $tmpDir "pnpm-workspace.yaml")',
    );
    expect(script).toContain(
      'Copy-Item -Recurse (Join-Path $repoDir "patches") (Join-Path $tmpDir "patches")',
    );
  });

  it("initializes Windows options once with the plural workspace-root schema", async () => {
    const script = await fs.readFile(
      path.join(process.cwd(), "scripts", "deploy-windows.ps1"),
      "utf8",
    );
    expect(script).toContain('(Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmssfff")');
    expect(script).toContain("if (Test-Path $optionsPath) {");
    expect(script).toContain("workspacesRoots = @($WorkspacesRoots)");
    expect(script).toContain("Get-Content -Raw $optionsPath | ConvertFrom-Json");
    expect(script).toContain("IIS AppPath '$AppPath' and Batty BaseUrl '$BaseUrl'");
    expect(script).toContain("is configured for baseUrl '$configuredBaseUrl'");
    expect(script).not.toContain("pnpm test");
    expect(script).not.toMatch(/\bworkspacesRoot\s*=/);
  });

  it("hands Windows service activation to a detached process after a delay", async () => {
    const [deployScript, handoffScript, workerScript] = await Promise.all([
      fs.readFile(path.join(process.cwd(), "scripts", "deploy-windows.ps1"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "handoff-restart-windows.ps1"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "complete-deployment-windows.ps1"), "utf8"),
    ]);

    expect(deployScript).toContain('Step "Configuring Windows service"');
    expect(deployScript).toContain('Step "Handing off deployment reload"');
    expect(deployScript).toContain('Join-Path $scriptDir "handoff-restart-windows.ps1"');
    expect(handoffScript).toContain("Invoke-CimMethod -ClassName Win32_Process");
    expect(workerScript.indexOf("Start-Sleep")).toBeLessThan(
      workerScript.indexOf("Stop-Service -Name Batty"),
    );
    expect(workerScript.indexOf("Stop-Service -Name Batty")).toBeLessThan(
      workerScript.indexOf("New-Item -ItemType Junction"),
    );
    expect(workerScript.indexOf("New-Item -ItemType Junction")).toBeLessThan(
      workerScript.indexOf("Start-Service -Name Batty"),
    );
    expect(workerScript).toContain("$previousReleaseDir = $current.Target");
    expect(workerScript).toContain("Deployment failed; restored '$previousReleaseDir'.");
    expect(workerScript).toContain("Rollback also failed");
    expect(workerScript).toContain("uses app pool '$existingPool'");
  });

  it("runs Batty as a WinSW service behind an IIS reverse proxy", async () => {
    const [serviceScript, releaseScript, iisScript] = await Promise.all([
      fs.readFile(path.join(process.cwd(), "scripts", "install-windows-service.ps1"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "install-release.ps1"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "configure-iis-app.ps1"), "utf8"),
    ]);

    expect(serviceScript).toContain('$winSwVersion = "2.12.0"');
    expect(serviceScript).toContain(
      '$winSwSha256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da"',
    );
    expect(serviceScript).toContain('<env name="BATTY_PORT" value="$Port" />');
    expect(serviceScript).toContain('<onfailure action="restart" delay="10 sec" />');
    expect(releaseScript).toContain('<rule name="Batty reverse proxy" stopProcessing="true">');
    expect(releaseScript).not.toContain("AspNetCoreModuleV2");
    expect(releaseScript).not.toContain("%ASPNETCORE_PORT%");
    expect(releaseScript).not.toContain('<webSocket enabled="true" />');
    expect(iisScript).toContain("Get-WebGlobalModule -Name RewriteModule");
    expect(iisScript).toContain("Get-WebGlobalModule -Name ApplicationRequestRouting");
    expect(iisScript).toContain('-Filter "system.webServer/proxy" -Name "enabled" -Value $true');
  });
});
