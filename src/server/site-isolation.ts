import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { SITE_WORKER_SOURCE } from "./site-worker-source";
import { SITE_MAX_BYTES, type SiteRequest } from "./site-http";

const exec = promisify(execFile);
let runtime: Promise<string> | undefined;
const units = new Map<string, () => Promise<void>>();

export async function createSiteIsolationRuntime(source = SITE_WORKER_SOURCE): Promise<string> {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new Error("Site backend functions require Linux systemd isolation managed by root");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-site-runtime-"));
  try {
    const copy = async (source: string, destination: string) => {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    };
    for (const executable of [process.execPath, "/usr/bin/env"]) {
      await copy(
        executable,
        path.join(root, executable === process.execPath ? "usr/bin/node" : "usr/bin/env"),
      );
      const { stdout } = await exec("ldd", [executable], { timeout: 5000 });
      for (const library of new Set(stdout.match(/\/[^\s()]+/g) ?? []))
        await copy(library, path.join(root, library));
    }
    const codemodeEntry = import.meta.resolve("@earendil-works/pi-codemode");
    const codemode = path.dirname(path.dirname(fileURLToPath(codemodeEntry)));
    const quickjs = path.dirname(createRequire(codemodeEntry).resolve("quickjs-wasi/package.json"));
    await fs.mkdir(path.join(root, "runtime/node_modules/@earendil-works"), { recursive: true });
    await fs.cp(codemode, path.join(root, "runtime/node_modules/@earendil-works/pi-codemode"), {
      recursive: true,
      dereference: true,
    });
    await fs.cp(quickjs, path.join(root, "runtime/node_modules/quickjs-wasi"), {
      recursive: true,
      dereference: true,
    });
    await fs.writeFile(path.join(root, "runtime/worker.mjs"), source);
    await fs.mkdir(path.join(root, "tmp"));
    const makeReadable = async (directory: string): Promise<void> => {
      await fs.chmod(directory, 0o755);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await makeReadable(file);
        else await fs.chmod(file, (await fs.stat(file)).mode & 0o111 ? 0o755 : 0o644);
      }
    };
    await makeReadable(root);
    return root;
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function siteIsolationProperties(root: string): string[] {
  return [
    `RootDirectory=${root}`,
    "WorkingDirectory=/runtime",
    "MountAPIVFS=yes",
    "DynamicUser=yes",
    "PrivateNetwork=yes",
    "InaccessiblePaths=/tmp /var/tmp",
    "PrivateDevices=yes",
    "PrivateIPC=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "ProtectProc=invisible",
    "ProcSubset=pid",
    "NoNewPrivileges=yes",
    "CapabilityBoundingSet=",
    "RestrictSUIDSGID=yes",
    "RestrictNamespaces=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "RestrictAddressFamilies=AF_UNIX",
    "MemoryMax=256M",
    "MemorySwapMax=0",
    "CPUQuota=100%",
    "TasksMax=16",
    "RuntimeMaxSec=65",
    "TimeoutStopSec=1",
    "KillMode=control-group",
    "TemporaryFileSystem=/work:rw,nodev,nosuid,noexec,size=8M,mode=1777",
  ];
}

async function stopUnit(unit: string): Promise<void> {
  // Stop the cgroup, not only the local systemd-run helper. No user-controlled unit names.
  await exec("systemctl", ["stop", unit], { timeout: 5000 }).catch(async (error) => {
    const { stdout } = await exec("systemctl", ["show", unit, "--property=LoadState", "--value"], {
      timeout: 5000,
    });
    if (stdout.trim() !== "not-found") throw error;
  });
}

/** Fully untrusted line protocol, including after arbitrary Node execution in the unit. */
export async function runIsolatedSiteFunction(
  code: string,
  input: unknown,
  request: (args: SiteRequest) => Promise<unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const root = await (runtime ??= createSiteIsolationRuntime());
  return runSiteUnit(root, { code, input: input ?? null }, request, signal);
}

export async function runSiteUnit(
  root: string,
  initial: unknown,
  request: (args: SiteRequest) => Promise<unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const unit = `batty-site-${randomUUID()}.service`;
  const child = spawn(
    "systemd-run",
    [
      "--no-ask-password",
      "--pipe",
      "--wait",
      "--collect",
      "--service-type=exec",
      `--unit=${unit}`,
      ...siteIsolationProperties(root).flatMap((value) => ["--property", value]),
      "/usr/bin/env",
      "-i",
      "PATH=/usr/bin",
      "LANG=C.UTF-8",
      "TMPDIR=/work",
      "/usr/bin/node",
      "/runtime/worker.mjs",
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      timeout: 75_000,
      killSignal: "SIGKILL",
    },
  );
  let markRegistered!: () => void;
  let rejectRegistration!: (error: Error) => void;
  const registered = new Promise<void>((resolve, reject) => {
    markRegistered = resolve;
    rejectRegistration = reject;
  });
  void registered.catch(() => {});
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", (error) => {
      rejectRegistration(error);
      reject(error);
    });
    child.once("close", (status) => {
      rejectRegistration(new Error("Site isolation did not start"));
      resolve(status);
    });
  });
  void completion.catch(() => {});
  units.set(unit, async () => {
    await registered;
    await stopUnit(unit);
    await completion;
  });
  let stderr = "";
  let done = false;
  let result: unknown;
  let failed: Error | undefined;
  let buffered = Buffer.alloc(0);
  let bytes = 0;
  let stderrBytes = 0;
  let count = 0;
  const ids = new Set<number>();
  const work: Promise<unknown>[] = [];
  let stopping: Promise<void> | undefined;
  const fail = (message: string) => {
    failed ??= new Error(message);
    child.stdin.end();
    // A stop before transient registration can miss the unit. Wait for launch acknowledgement.
    stopping ??= registered.then(() => stopUnit(unit));
    void stopping.catch(() => {});
  };
  const onAbort = () => fail("Site function cancelled or timed out");
  signal.addEventListener("abort", onAbort, { once: true });
  child.stdin.on("error", () => fail("Site worker input failed"));
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 8192) {
      fail("Site worker stderr limit exceeded");
      return;
    }
    stderr += chunk.toString("utf8");
    if (stderr.includes(`Running as unit: ${unit}`)) markRegistered();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    // Payload output also proves the unit exists, even if launcher stderr arrives later.
    markRegistered();
    bytes += chunk.length;
    if (bytes > SITE_MAX_BYTES * 2 || buffered.length + chunk.length > SITE_MAX_BYTES) {
      fail("Site worker output limit exceeded");
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    let end: number;
    while ((end = buffered.indexOf(10)) !== -1) {
      const line = buffered.subarray(0, end);
      buffered = buffered.subarray(end + 1);
      try {
        if (failed || done || ++count > 13) throw new Error("Invalid protocol");
        const message = JSON.parse(line.toString("utf8"));
        if (
          message.type === "done" &&
          Object.keys(message).every((key) => ["type", "value"].includes(key))
        ) {
          done = true;
          result = message.value ?? null;
        } else if (message.type === "failed" && Object.keys(message).length === 1) {
          throw new Error("Function failed");
        } else if (
          message.type === "request" &&
          Object.keys(message).every((key) => ["type", "id", "args"].includes(key))
        ) {
          if (
            !Number.isSafeInteger(message.id) ||
            message.id < 1 ||
            ids.has(message.id) ||
            ids.size >= 12
          )
            throw new Error("Invalid request id");
          const args = message.args;
          if (
            !args ||
            typeof args !== "object" ||
            Array.isArray(args) ||
            typeof args.connection !== "string" ||
            Object.keys(args).some(
              (key) => !["connection", "method", "body", "path"].includes(key),
            ) ||
            (args.method !== undefined &&
              !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(args.method)) ||
            (args.path !== undefined && typeof args.path !== "string")
          )
            throw new Error("Invalid request");
          ids.add(message.id);
          const reply = async () => {
            let response: object;
            try {
              response = { id: message.id, value: await request(args) };
            } catch {
              response = { id: message.id, error: "Connection request failed" };
            }
            if (!done && !failed) child.stdin.write(JSON.stringify(response) + "\n");
          };
          work.push(reply());
        } else throw new Error("Invalid message");
      } catch {
        fail("Site function failed or violated its worker protocol");
      }
    }
  });
  try {
    if (signal.aborted) onAbort();
    await registered;
    if (!failed) child.stdin.write(JSON.stringify(initial) + "\n");
    const status = await completion;
    if (failed) throw failed;
    if (status !== 0 || !done || buffered.length)
      throw new Error("Isolated site worker failed; Linux systemd isolation is required");
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Confirm cgroup termination before releasing its admission slot or staging files.
    // An early failed stop must never skip the post-launch stop and cleanup.
    await Promise.allSettled(stopping ? [stopping] : []);
    await completion.catch(() => {});
    try {
      await stopUnit(unit);
    } finally {
      await Promise.allSettled(work);
      units.delete(unit);
    }
  }
}

export async function closeSiteFunctionRuntime(): Promise<void> {
  await Promise.all([...units.values()].map((stop) => stop()));
  if (runtime) {
    const root = await runtime;
    await fs.rm(root, { recursive: true, force: true });
    runtime = undefined;
  }
}
