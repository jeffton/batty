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

  linuxIt("passes the initiating session to the detached Linux manager", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-linux-handoff-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    const captured = path.join(root, "arguments");
    await fs.writeFile(
      path.join(bin, "systemd-run"),
      '#!/bin/bash\nprintf "%s\\n" "$@" >"$CAPTURED"\n',
      { mode: 0o755 },
    );
    const sessionPath = "/session with spaces.sqlite";
    const result = await execFileAsync(
      "bash",
      [path.join(process.cwd(), "scripts", "handoff-restart.sh")],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CAPTURED: captured,
          PI_SESSION_FILE: sessionPath,
          PI_RESTART_AFTER_ENTRY_ID: "tool-use-entry",
          BATTY_RESTART_SESSION_FILE: "/wrong-session.sqlite",
        },
      },
    );
    expect(result.stdout).toContain("Handed off restart");
    expect((await fs.readFile(captured, "utf8")).split("\n")).toContain(
      `--setenv=BATTY_RESTART_SESSION_FILE=${sessionPath}`,
    );
    expect((await fs.readFile(captured, "utf8")).split("\n")).toContain(
      "--setenv=BATTY_RESTART_AFTER_ENTRY_ID=tool-use-entry",
    );
  });

  it("checkpoints Linux deployments through the prepared CLI", async () => {
    const [deployScript, reloadScript, handoffScript, restartScript] = await Promise.all([
      fs.readFile(path.join(process.cwd(), "scripts", "deploy.sh"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "reload-self.sh"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "handoff-restart.sh"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "restart-services.sh"), "utf8"),
    ]);

    expect(deployScript).toContain('"$repo_dir/scripts/handoff-restart.sh"');
    expect(deployScript.indexOf("pnpm build")).toBeLessThan(
      deployScript.indexOf("scripts/install-release.sh"),
    );
    expect(deployScript).not.toContain("--force");
    expect(reloadScript).toContain('"$repo_dir/scripts/handoff-restart.sh"');
    expect(reloadScript).not.toContain("--force");
    expect(handoffScript).toContain("systemd-run \\");
    expect(handoffScript).toContain('/bin/bash "$script_dir/restart-services.sh"');
    expect(handoffScript).not.toMatch(/sleep|delay_seconds/);
    expect(handoffScript).toContain('--setenv="BATTY_INSTALL_ROOT=$install_root"');
    expect(handoffScript).toContain('--setenv="BATTY_ROOT=$batty_root"');
    expect(handoffScript).toContain('--setenv="BATTY_PORT=$backend_port"');
    expect(handoffScript).toContain('--setenv="BATTY_NODE=$node_path"');
    expect(handoffScript).toContain('--setenv="BATTY_RESTART_SESSION_FILE=${PI_SESSION_FILE:-}"');
    expect(handoffScript).toContain(
      '--setenv="BATTY_RESTART_AFTER_ENTRY_ID=${PI_RESTART_AFTER_ENTRY_ID:-}"',
    );
    expect(restartScript).toContain(
      'checkpoint_args=(--session "${BATTY_RESTART_SESSION_FILE:-}" --after-entry "${BATTY_RESTART_AFTER_ENTRY_ID:-}")',
    );
    expect(restartScript).toContain('drain "${checkpoint_args[@]}"');
    expect(handoffScript).toContain('--setenv="BATTY_SKIP_DRAIN=${BATTY_SKIP_DRAIN:-}"');
    expect(restartScript).toContain('node_path="${BATTY_NODE:-$(command -v node)}"');
    const linuxDrain =
      '"$node_path" "$install_root/current/dist/server/cli.mjs" --root "$batty_root" drain';
    expect(restartScript).toContain(linuxDrain);
    expect(restartScript.indexOf(linuxDrain)).toBeLessThan(
      restartScript.indexOf("systemctl stop batty.service"),
    );
    expect(restartScript.indexOf("systemctl stop batty.service")).toBeLessThan(
      restartScript.indexOf("systemctl start batty.service"),
    );
    expect(restartScript.indexOf("systemctl start batty.service")).toBeLessThan(
      restartScript.indexOf('wait_for_url "http://127.0.0.1:${backend_port}/healthz"'),
    );
    expect(restartScript).not.toContain("drain --wait");
    expect(restartScript).toContain('"${BATTY_SKIP_DRAIN:-}" != "1"');
    expect(restartScript).toContain('wait_for_url "http://127.0.0.1/"');
    expect(restartScript).not.toContain('wait_for_url "http://127.0.0.1:${backend_port}/"');
    expect(restartScript).not.toContain("deployment/drain");
    expect(restartScript).not.toContain("authSecret");
  });

  it("installs macOS deployments as a user launch agent with an immediate detached reload", async () => {
    const [deployScript, handoffScript, restartScript] = await Promise.all([
      fs.readFile(path.join(process.cwd(), "scripts", "deploy-macos.sh"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "handoff-restart-macos.sh"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "restart-services-macos.sh"), "utf8"),
    ]);

    expect(deployScript).toContain('label="se.roybot.batty"');
    expect(deployScript).toContain('if [[ "$(id -u)" -eq 0 ]]');
    expect(deployScript).toContain('webPushSubject: "mailto:batty@localhost"');
    expect(deployScript).toContain('if [[ "$was_running" == true ]]');
    expect(deployScript.indexOf("pnpm build")).toBeLessThan(
      deployScript.indexOf("install-release.sh"),
    );
    expect(handoffScript).toContain('launchctl bootstrap "$domain" "$plist"');
    expect(handoffScript).toContain('"restart-services-macos.sh"');
    expect(handoffScript).not.toContain("nohup");
    expect(handoffScript).toContain('"KeepAlive": False');
    expect(handoffScript).toContain('launchctl bootout "$BATTY_RELOAD_SERVICE"');
    expect(handoffScript).not.toMatch(/sleep|delay_seconds/);
    expect(handoffScript).toContain('BATTY_INSTALL_ROOT="$install_root"');
    expect(handoffScript).toContain('BATTY_ROOT="$batty_root"');
    expect(handoffScript).toContain('BATTY_PORT="$backend_port"');
    expect(handoffScript).toContain('BATTY_NODE="$node_path"');
    expect(handoffScript).toContain('BATTY_RESTART_SESSION_FILE="${PI_SESSION_FILE:-}"');
    expect(handoffScript).toContain(
      'BATTY_RESTART_AFTER_ENTRY_ID="${PI_RESTART_AFTER_ENTRY_ID:-}"',
    );
    expect(restartScript).toContain(
      'checkpoint_args=(--session "${BATTY_RESTART_SESSION_FILE:-}" --after-entry "${BATTY_RESTART_AFTER_ENTRY_ID:-}")',
    );
    expect(restartScript).toContain('drain "${checkpoint_args[@]}"');
    expect(handoffScript).toContain('BATTY_SKIP_DRAIN="${BATTY_SKIP_DRAIN:-}"');
    expect(restartScript).toContain('launchctl bootstrap "$domain" "$plist"');
    expect(restartScript).toContain('node_path="${BATTY_NODE:-$(command -v node)}"');
    const macosDrain = '"$install_root/current/dist/server/cli.mjs" --root "$batty_root" drain';
    expect(restartScript).toContain(macosDrain);
    expect(restartScript.indexOf(macosDrain)).toBeLessThan(
      restartScript.indexOf('launchctl bootout "${domain}/${label}"'),
    );
    expect(restartScript.indexOf('launchctl bootout "${domain}/${label}"')).toBeLessThan(
      restartScript.indexOf('launchctl bootstrap "$domain" "$plist"'),
    );
    expect(restartScript.indexOf('launchctl kickstart -k "${domain}/${label}"')).toBeLessThan(
      restartScript.indexOf("curl --fail --silent --head --max-time 2"),
    );
    expect(restartScript).not.toContain("drain --wait");
    expect(restartScript).toContain('"${BATTY_SKIP_DRAIN:-}" != "1"');
    expect(restartScript).not.toContain("deployment/drain");
    expect(restartScript).not.toContain("authSecret");
  });

  linuxIt.each([0, 5])(
    "submits a one-shot macOS reload job and propagates bootstrap exit %i",
    async (code) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-macos-handoff-"));
      tempDirs.push(root);
      const bin = path.join(root, "bin");
      await fs.mkdir(bin);
      const captured = path.join(root, "job.json");
      await fs.writeFile(path.join(bin, "uuidgen"), "#!/bin/bash\necho test-reload\n", {
        mode: 0o755,
      });
      await fs.writeFile(
        path.join(bin, "launchctl"),
        `#!/bin/bash
python3 - "$3" "$CAPTURED" <<'PY'
import json, plistlib, sys
assert sys.argv[1].endswith('.plist')
with open(sys.argv[1], 'rb') as source:
    job = plistlib.load(source)
with open(sys.argv[2], 'w') as output:
    json.dump(job, output)
PY
exit ${code}
`,
        { mode: 0o755 },
      );
      const env = {
        ...process.env,
        HOME: root,
        PATH: `${bin}:${process.env.PATH}`,
        CAPTURED: captured,
        BATTY_INSTALL_ROOT: "/release with spaces",
        BATTY_ROOT: "/workspace with spaces",
        BATTY_PORT: "4321",
        BATTY_NODE: "/node with spaces",
        BATTY_SKIP_DRAIN: "1",
        PI_SESSION_FILE: "/session with spaces.sqlite",
        PI_RESTART_AFTER_ENTRY_ID: "tool-use-entry",
      };
      const run = execFileAsync(
        "bash",
        [path.join(process.cwd(), "scripts", "handoff-restart-macos.sh")],
        { env },
      );
      if (code === 0) {
        expect((await run).stdout).toContain("Handed off launchd reload");
      } else {
        await expect(run).rejects.toMatchObject({ code });
      }
      const job = JSON.parse(await fs.readFile(captured, "utf8"));
      expect(job.Label).toBe("se.roybot.batty-reload-test-reload");
      expect(job.RunAtLoad).toBe(true);
      expect(job.KeepAlive).toBe(false);
      expect(job.EnvironmentVariables).toMatchObject({
        BATTY_INSTALL_ROOT: env.BATTY_INSTALL_ROOT,
        BATTY_ROOT: env.BATTY_ROOT,
        BATTY_PORT: "4321",
        BATTY_NODE: env.BATTY_NODE,
        BATTY_SKIP_DRAIN: "1",
        BATTY_RESTART_SESSION_FILE: env.PI_SESSION_FILE,
        BATTY_RESTART_AFTER_ENTRY_ID: env.PI_RESTART_AFTER_ENTRY_ID,
        PATH: env.PATH,
      });
      expect(job.ProgramArguments.slice(-2)).toEqual([
        "/bin/bash",
        path.join(process.cwd(), "scripts", "restart-services-macos.sh"),
      ]);
      expect(await fs.readdir(path.join(root, "Library", "Logs", "Batty"))).toEqual([]);
    },
  );

  linuxIt("waits for asynchronous macOS bootout before bootstrapping the replacement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-macos-bootout-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    const trace = path.join(root, "trace");
    await fs.writeFile(
      path.join(bin, "launchctl"),
      `#!/bin/bash
set -eu
echo "$1" >>"$TRACE"
case "$1" in
  print)
    if [[ ! -f "$STATE" ]]; then exit 0; fi
    count=$(<"$STATE")
    if [[ "$count" -ge 3 ]]; then exit 1; fi
    echo "$((count + 1))" >"$STATE"
    ;;
  bootout) echo 0 >"$STATE" ;;
  bootstrap) [[ $(<"$STATE") -ge 3 ]] ;;
esac
`,
      { mode: 0o755 },
    );
    await fs.writeFile(
      path.join(bin, "node"),
      '#!/bin/bash\necho drain >>"$TRACE"\nprintf "%s\\n" "$@" >"$CLI_ARGS"\n',
      {
        mode: 0o755,
      },
    );
    await fs.writeFile(path.join(bin, "sleep"), '#!/bin/bash\necho wait >>"$TRACE"\n', {
      mode: 0o755,
    });
    await fs.writeFile(path.join(bin, "curl"), '#!/bin/bash\necho health >>"$TRACE"\n', {
      mode: 0o755,
    });
    await execFileAsync(
      "bash",
      [path.join(process.cwd(), "scripts", "restart-services-macos.sh")],
      {
        env: {
          ...process.env,
          HOME: root,
          PATH: `${bin}:${process.env.PATH}`,
          BATTY_NODE: path.join(bin, "node"),
          BATTY_SKIP_DRAIN: "",
          BATTY_RESTART_SESSION_FILE: "/session with spaces.sqlite",
          BATTY_RESTART_AFTER_ENTRY_ID: "tool-use-entry",
          CLI_ARGS: path.join(root, "cli-args"),
          STATE: path.join(root, "state"),
          TRACE: trace,
        },
      },
    );
    expect(
      (await fs.readFile(path.join(root, "cli-args"), "utf8")).trim().split("\n").slice(-5),
    ).toEqual([
      "drain",
      "--session",
      "/session with spaces.sqlite",
      "--after-entry",
      "tool-use-entry",
    ]);
    expect((await fs.readFile(trace, "utf8")).trim().split("\n")).toEqual([
      "print",
      "drain",
      "bootout",
      "print",
      "wait",
      "print",
      "wait",
      "print",
      "wait",
      "print",
      "bootstrap",
      "enable",
      "kickstart",
      "health",
    ]);
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
    expect(script).toContain("pnpm exec patchright install chromium");
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

  it("hands Windows service activation immediately to a detached process", async () => {
    const [deployScript, handoffScript, workerScript] = await Promise.all([
      fs.readFile(path.join(process.cwd(), "scripts", "deploy-windows.ps1"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "handoff-restart-windows.ps1"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "complete-deployment-windows.ps1"), "utf8"),
    ]);

    expect(deployScript).toContain('Step "Configuring Windows service"');
    expect(deployScript).toContain('Step "Handing off deployment reload"');
    expect(deployScript).toContain('Join-Path $scriptDir "handoff-restart-windows.ps1"');
    expect(deployScript).toContain("[switch]$Force");
    expect(handoffScript).toContain("Invoke-CimMethod -ClassName Win32_Process");
    expect(handoffScript).toContain(
      '$trailingBackslashes = [regex]::Match($value, "\\\\+$").Value',
    );
    expect(handoffScript).toContain('return "`"$value$trailingBackslashes`""');
    expect(handoffScript).toContain("$powershell = (Get-Command powershell.exe).Source");
    expect(handoffScript).toContain("-BattyRoot $(Quote-Argument $BattyRoot)");
    expect(handoffScript).toContain("-RestartSessionFile $(Quote-Argument $env:PI_SESSION_FILE)");
    expect(workerScript).toContain("$env:BATTY_RESTART_SESSION_FILE = $RestartSessionFile");
    expect(handoffScript).toContain(
      "-RestartAfterEntryId $(Quote-Argument $env:PI_RESTART_AFTER_ENTRY_ID)",
    );
    expect(workerScript).toContain("$env:BATTY_RESTART_AFTER_ENTRY_ID = $RestartAfterEntryId");
    expect(workerScript).toContain(
      '@("--session", $env:BATTY_RESTART_SESSION_FILE, "--after-entry", $env:BATTY_RESTART_AFTER_ENTRY_ID)',
    );
    expect(workerScript).toContain("drain @checkpointArgs");
    expect(handoffScript).toContain("if ($Force)");
    expect(handoffScript).toContain('$arguments += "-Force"');
    expect(handoffScript).not.toContain('"-Force:$Force"');
    expect(handoffScript).not.toContain("DelaySeconds");
    expect(workerScript).not.toContain("DelaySeconds");
    expect(workerScript.match(/Start-Sleep/g)).toHaveLength(1);
    expect(workerScript).toContain("Start-Sleep -Seconds 1");
    expect(workerScript).toContain("function Wait-ForDeploymentDrain");
    expect(workerScript).toContain("(Get-Command node).Source $cliPath --root $battyRoot drain");
    expect(workerScript).toContain('$cliPath = Join-Path $releaseDir "dist\\server\\cli.mjs"');
    expect(workerScript).toContain('$serviceStatus -ne "Stopped" -and -not $Force');
    expect(workerScript).not.toContain("drain --wait");
    expect(workerScript.indexOf("Wait-ForDeploymentDrain $cliPath $BattyRoot")).toBeLessThan(
      workerScript.indexOf("Stop-Service -Name Batty"),
    );
    expect(workerScript).not.toContain("deployment/drain");
    expect(workerScript).not.toContain("authSecret");
    expect(workerScript).toContain("if ($activationStarted -and $previousReleaseDir)");
    expect(workerScript.indexOf("Stop-Service -Name Batty")).toBeLessThan(
      workerScript.indexOf("$activationStarted = $true"),
    );
    expect(workerScript.indexOf("$activationStarted = $true")).toBeLessThan(
      workerScript.indexOf("New-Item -ItemType Junction"),
    );
    expect(workerScript.indexOf("Stop-Service -Name Batty")).toBeLessThan(
      workerScript.indexOf("New-Item -ItemType Junction"),
    );
    expect(workerScript.indexOf("New-Item -ItemType Junction")).toBeLessThan(
      workerScript.indexOf("Start-Service -Name Batty"),
    );
    expect(workerScript.indexOf("Start-Service -Name Batty")).toBeLessThan(
      workerScript.indexOf('Wait-ForUrl "http://127.0.0.1:$BackendPort$backendPath/healthz"'),
    );
    expect(workerScript).toContain(
      "New-Item -ItemType Junction -Path $currentDir -Target $previousReleaseDir",
    );
    expect(workerScript).toContain("$previousReleaseDir = $current.Target");
    expect(workerScript).toContain("Deployment failed; restored '$previousReleaseDir'.");
    expect(workerScript).toContain("Rollback also failed");
  });

  it("runs Batty as a WinSW service behind an IIS reverse proxy", async () => {
    const [serviceScript, releaseScript, iisScript] = await Promise.all([
      fs.readFile(path.join(process.cwd(), "scripts", "install-windows-service.ps1"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "install-release.ps1"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "configure-iis-app.ps1"), "utf8"),
    ]);

    expect(serviceScript).toContain('$winSwVersion = "2.12.0"');
    expect(serviceScript).toContain("function Get-Sha256");
    expect(serviceScript).not.toContain("Get-FileHash");
    expect(serviceScript).toContain(
      '$winSwSha256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da"',
    );
    expect(serviceScript).toContain('<env name="BATTY_PORT" value="$Port" />');
    expect(serviceScript).toContain('<onfailure action="restart" delay="10 sec" />');
    expect(serviceScript).toContain(
      "if (-not (Get-Service -Name Batty -ErrorAction SilentlyContinue)) {",
    );
    expect(serviceScript).not.toContain("serviceaccount");
    expect(serviceScript).not.toContain("uninstall");
    expect(releaseScript).toContain(
      '<rule name="Batty HTTPS reverse proxy" stopProcessing="true">',
    );
    expect(releaseScript).toContain('<rule name="Batty HTTP reverse proxy" stopProcessing="true">');
    expect(releaseScript).toContain('<set name="HTTP_X_FORWARDED_HOST" value="{HTTP_HOST}" />');
    expect(releaseScript).toContain('<set name="HTTP_X_FORWARDED_PROTO" value="https" />');
    expect(releaseScript).toContain('<set name="HTTP_X_FORWARDED_PROTO" value="http" />');
    expect(releaseScript).not.toContain("AspNetCoreModuleV2");
    expect(releaseScript).not.toContain("%ASPNETCORE_PORT%");
    expect(releaseScript).not.toContain('<webSocket enabled="true" />');
    expect(iisScript).toContain("Get-WebGlobalModule -Name RewriteModule");
    expect(iisScript).toContain("Get-WebGlobalModule -Name ApplicationRequestRouting");
    expect(iisScript).toContain('-Filter "system.webServer/proxy" -Name "enabled" -Value $true');
    expect(iisScript).toContain("system.webServer/rewrite/allowedServerVariables");
    expect(iisScript).toContain('"HTTP_X_FORWARDED_HOST"');
    expect(iisScript).toContain('"HTTP_X_FORWARDED_PROTO"');
  });
});
