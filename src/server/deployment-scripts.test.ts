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

  linuxIt("hands Linux restart to systemd with its configured environment", async () => {
    const fixture = await createInstallFixture(0);
    const bin = fixture.env.PATH!.split(path.delimiter)[0]!;
    const captured = path.join(fixture.installRoot, "handoff-args");
    await fs.writeFile(
      path.join(bin, "systemd-run"),
      '#!/bin/bash\nprintf "%s\\n" "$@" >"$CAPTURED"\n',
      { mode: 0o755 },
    );
    const env = {
      ...fixture.env,
      BATTY_INSTALL_ROOT: "/release with spaces",
      BATTY_ROOT: "/workspace with spaces",
      BATTY_PORT: "4321",
      BATTY_NODE: "/node with spaces",
      BATTY_SKIP_DRAIN: "1",
      CAPTURED: captured,
    };
    await execFileAsync("bash", [path.resolve("scripts/handoff-restart.sh")], { env });
    const args = (await fs.readFile(captured, "utf8")).trim().split("\n");
    expect(args).toContain("--collect");
    expect(args[args.indexOf("--unit") + 1]).toMatch(/^batty-reload-\d+$/);
    for (const name of [
      "BATTY_INSTALL_ROOT",
      "BATTY_ROOT",
      "BATTY_PORT",
      "BATTY_NODE",
      "BATTY_SKIP_DRAIN",
    ] as const) {
      expect(args).toContain(`--setenv=${name}=${env[name]}`);
    }
    expect(args.slice(-2)).toEqual(["/bin/bash", path.resolve("scripts/restart-services.sh")]);
  });

  linuxIt.each([
    ["active", "", 0],
    ["inactive", "", 0],
    ["active", "1", 0],
    ["active", "", 7],
  ])("drains Linux state %s with skip=%s and drain exit %i", async (state, skip, drainExit) => {
    const fixture = await createInstallFixture(0);
    const bin = fixture.env.PATH!.split(path.delimiter)[0]!;
    const trace = path.join(fixture.installRoot, "trace");
    await Promise.all([
      fs.writeFile(
        path.join(bin, "systemctl"),
        '#!/bin/bash\necho "systemctl $*" >>"$TRACE"\nif [[ "$*" == "is-active batty.service" ]]; then echo "$SERVICE_STATE"; fi\n',
        { mode: 0o755 },
      ),
      fs.writeFile(
        path.join(bin, "node"),
        `#!/bin/bash
[[ "$1" == "$BATTY_INSTALL_ROOT/current/dist/server/cli.mjs" && "$2" == "--root" && "$3" == "$BATTY_ROOT" && "$4" == "drain" ]] || exit 99
echo drain >>"$TRACE"
exit "$DRAIN_EXIT"
`,
        { mode: 0o755 },
      ),
      fs.writeFile(path.join(bin, "curl"), '#!/bin/bash\necho "health ${!#}" >>"$TRACE"\n', {
        mode: 0o755,
      }),
    ]);
    const run = execFileAsync("bash", [path.resolve("scripts/restart-services.sh")], {
      env: {
        ...fixture.env,
        BATTY_ROOT: "/workspace with spaces",
        BATTY_NODE: path.join(bin, "node"),
        BATTY_PORT: "4321",
        BATTY_SKIP_DRAIN: skip,
        SERVICE_STATE: state,
        DRAIN_EXIT: String(drainExit),
        TRACE: trace,
      },
    });
    if (drainExit) {
      await expect(run).rejects.toMatchObject({ code: drainExit });
    } else {
      await run;
    }
    const prefix = ["systemctl daemon-reload", "systemctl is-active batty.service"];
    if (state === "active" && skip !== "1") prefix.push("drain");
    expect((await fs.readFile(trace, "utf8")).trim().split("\n")).toEqual(
      drainExit
        ? prefix
        : [
            ...prefix,
            "systemctl enable batty.service",
            "systemctl stop batty.service",
            "systemctl start batty.service",
            "systemctl reload nginx",
            "systemctl is-active --quiet batty.service",
            "health http://127.0.0.1:4321/healthz",
            "health http://127.0.0.1/",
          ],
    );
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
    await fs.writeFile(path.join(bin, "node"), '#!/bin/bash\necho drain >>"$TRACE"\n', {
      mode: 0o755,
    });
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
          STATE: path.join(root, "state"),
          TRACE: trace,
        },
      },
    );
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
});
