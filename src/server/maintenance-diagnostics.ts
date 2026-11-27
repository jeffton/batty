import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { promisify } from "node:util";
import type { MaintenanceJob } from "./maintenance-state";

const exec = promisify(execFile);
const runtimeProperties = ["ActiveState", "SubState", "Result", "ExecMainStatus"];
const jobProperties = ["LoadState", "InvocationID", ...runtimeProperties];

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

function validateJobUnit(unit: string) {
  if (!/^[\w:][\w:.@\\-]*\.service$/.test(unit))
    throw new Error("--job-unit must name a systemd service, including .service");
}

function jobInFlight(status: Record<string, string>) {
  return (
    ["activating", "reloading", "deactivating"].includes(status.ActiveState ?? "") ||
    (status.ActiveState === "active" && status.SubState !== "exited")
  );
}

export async function identifyMaintenanceJob(unit: string): Promise<MaintenanceJob> {
  validateJobUnit(unit);
  const status = await readUnit(unit, jobProperties);
  if (
    status.LoadState !== "loaded" ||
    !jobInFlight(status) ||
    !status.InvocationID ||
    /^0+$/.test(status.InvocationID)
  )
    throw new Error(`No running systemd invocation for ${unit}`);
  return { unit, invocationId: status.InvocationID };
}

export async function maintenanceJob(job: MaintenanceJob, signal?: AbortSignal) {
  validateJobUnit(job.unit);
  const status = await readUnit(job.unit, jobProperties, signal);
  const { LoadState, InvocationID, ActiveState, SubState, Result, ExecMainStatus } = status;
  if (LoadState !== "loaded" || InvocationID !== job.invocationId)
    return { unit: job.unit, available: false };
  return {
    unit: job.unit,
    available: true,
    ActiveState,
    SubState,
    ...(jobInFlight(status) ? {} : { Result, ExecMainStatus }),
  };
}

export function maintenanceRuntime(signal?: AbortSignal) {
  return readUnit("batty2.service", runtimeProperties, signal);
}

async function readUnit(unit: string, properties: string[], signal?: AbortSignal) {
  const { stdout } = await exec(
    "/usr/bin/systemctl",
    ["show", "--no-pager", ...properties.map((field) => `--property=${field}`), "--", unit],
    {
      env: { LANG: "C" },
      timeout: 3000,
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
