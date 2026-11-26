import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const runtimeProperties = ["ActiveState", "SubState", "Result", "ExecMainStatus"];
const unit = "batty2.service";

export async function maintenanceHealth(mainUrl: string, signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(3000);
  try {
    const response = await fetch(`${mainUrl}/healthz`, {
      redirect: "error",
      signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
    });
    if (!response.ok) return { reachable: true, healthy: false, httpStatus: response.status };
    const { ok, buildId } = (await response.json()) as { ok?: boolean; buildId?: string };
    return { reachable: true, healthy: ok === true, buildId };
  } catch {
    signal?.throwIfAborted();
    return { reachable: false, healthy: false };
  }
}

export async function maintenanceRuntime(signal?: AbortSignal) {
  const { stdout } = await exec(
    "/usr/bin/systemctl",
    ["show", "--no-pager", ...runtimeProperties.map((field) => `--property=${field}`), unit],
    {
      env: { LANG: "C" },
      signal,
    },
  );
  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => {
        const split = line.indexOf("=");
        return [line.slice(0, split), line.slice(split + 1)];
      }),
  );
}

export async function maintenanceDisk(root: string) {
  const { bsize, bavail, blocks } = await statfs(root);
  return { writableBytesAvailable: bsize * bavail, filesystemBytes: bsize * blocks };
}
