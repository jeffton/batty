import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
if (process.getuid() === 0) throw new Error("Run the WebKit tests as a non-root user.");
const project = JSON.parse(readFileSync("package.json", "utf8"));
const server = JSON.parse(readFileSync("scripts/webkit/package.json", "utf8"));
const version = project.devDependencies["playwright-core"];
const containerfile = readFileSync("scripts/webkit/Containerfile", "utf8");
if (
  server.dependencies["playwright-core"] !== version ||
  !containerfile.startsWith(`FROM mcr.microsoft.com/playwright:v${version}-noble@sha256:`)
) {
  throw new Error(
    "Update the WebKit server lockfile and pinned Ubuntu image with Playwright Core.",
  );
}
const podman = ["--cgroup-manager=cgroupfs"];
const info = JSON.parse(
  execFileSync("podman", [...podman, "info", "--format=json"], { encoding: "utf8" }),
);
if (!info.host.security.rootless) throw new Error("The WebKit runner requires rootless Podman.");
// Keep crun's state directory consistent if an SSH login creates /run/user mid-run.
process.env.XDG_RUNTIME_DIR = dirname(info.store.runRoot);
const image = execFileSync(
  "podman",
  [
    ...podman,
    "build",
    "--quiet",
    "--tag",
    `localhost/batty-webkit:${version}`,
    "--file",
    "scripts/webkit/Containerfile",
    "scripts/webkit",
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
).trim();
const name = `batty-webkit-${randomUUID()}`;
const endpointPath = `/${randomUUID()}`;
let tests;
let interrupted;
const stop = () =>
  execFileSync("podman", [...podman, "stop", "--ignore", name], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = signal;
    if (tests) process.kill(-tests.pid, signal);
    else stop();
  });
}
try {
  const container = spawn("podman", [
    ...podman,
    "run",
    "--name",
    name,
    "--init",
    "--user",
    "pwuser",
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    "--publish",
    "127.0.0.1::3000",
    image,
    "--path",
    endpointPath,
  ]);
  await new Promise((resolve, reject) => {
    let output = "";
    container.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("Listening on ws://")) resolve();
    });
    container.stderr.pipe(process.stderr);
    container.once("error", reject);
    container.once("exit", (code, signal) =>
      reject(new Error(`WebKit server exited before readiness: ${signal ?? code}`)),
    );
  });
  const address = execFileSync("podman", [...podman, "port", name, "3000/tcp"], {
    encoding: "utf8",
  }).trim();
  const args = process.argv.slice(2);
  const all = args[0] === "--all";
  if (all) args.shift();
  console.log(
    `WebKit ${version}: isolated Ubuntu browser; ${all ? "all" : "browser"} test groups.`,
  );
  tests = spawn(
    "pnpm",
    ["exec", "vp", "test", "--run", ...(all ? [] : ["--project", "browser"]), ...args],
    {
      stdio: "inherit",
      detached: true,
      env: {
        ...process.env,
        // Native profile fixtures move into /var/lib; avoid a separate /tmp mount.
        TMPDIR: process.env.TMPDIR ?? "/var/tmp",
        BATTY_TEST_WEBKIT_WS_ENDPOINT: `ws://${address}${endpointPath}`,
      },
    },
  );
  const [code, signal] = await once(tests, "exit");
  process.exitCode = interrupted || signal ? 1 : code;
} finally {
  stop();
  execFileSync("podman", [...podman, "rm", "--ignore", name], { stdio: "inherit" });
}
