import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { createAuthToken } from "./auth";
import { loadConfig } from "./config";
import { acquireLock } from "./lock";
import { identifyMaintenanceJob } from "./maintenance-diagnostics";
import {
  clearMaintenance,
  mainLoopback,
  maintenanceDir,
  readMaintenance,
  writeMaintenance,
  type MaintenanceModel,
} from "./maintenance-state";

export const maintenanceHelp = `Usage: batty2 [--root /var/lib/batty2] maintenance ACTION [options]
  enter       --url HTTPS_ORIGIN --message TEXT [status options]
  update      [status options]
  allow-start [status options]
  hold        [status options]
  exit
  status
Status options: --task TEXT --context TEXT --job-unit RUNNING.service
                --message TEXT --progress PERCENT|indeterminate
Context is for non-secret checkpoints, known blockers and handoff notes.
Enter redirects public traffic; stop Batty and wait for it to checkpoint before migrating.
Allow-start permits main to open its DB again without exposing it publicly.
Exit requires a healthy Batty listener. All commands report JSON.`;

export async function runMaintenanceCli(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      root: { type: "string", default: "/var/lib/batty2" },
      message: { type: "string" },
      task: { type: "string" },
      context: { type: "string" },
      "job-unit": { type: "string" },
      url: { type: "string" },
      progress: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(maintenanceHelp);
    return;
  }
  const [command, action, extra] = positionals;
  const editing = ["enter", "update", "allow-start", "hold"].includes(action ?? "");
  const message = values.message?.trim();
  const task = values.task?.trim();
  const context = values.context?.trim();
  const jobUnit = values["job-unit"];
  const hasUpdate = [message, task, context, jobUnit, values.progress].some(
    (value) => value !== undefined,
  );
  if (
    command !== "maintenance" ||
    extra ||
    (!editing && (hasUpdate || (action !== "exit" && action !== "status"))) ||
    message === "" ||
    task === "" ||
    (action === "enter" && (!message || !values.url)) ||
    (action !== "enter" && values.url !== undefined) ||
    (action === "update" && !hasUpdate)
  )
    throw new Error(maintenanceHelp);

  const progress =
    values.progress === undefined
      ? undefined
      : values.progress === "indeterminate"
        ? null
        : Number(values.progress);
  if (
    progress !== undefined &&
    progress !== null &&
    (!values.progress?.trim() || !Number.isFinite(progress) || progress < 0 || progress > 100)
  )
    throw new Error("--progress must be a percentage between 0 and 100 or indeterminate");

  const root = path.resolve(values.root);
  if (action === "status") {
    console.log(JSON.stringify((await readMaintenance(root)) ?? { active: false }));
    return;
  }
  const unlock = await acquireLock(path.join(maintenanceDir(root), "control.lock"));
  try {
    const state = await readMaintenance(root);
    if (action === "enter") {
      if (state) throw new Error("Batty is already in maintenance mode");
      const config = await loadConfig(root);
      const gateway = new URL(values.url!);
      if (gateway.protocol !== "https:" || gateway.href !== `${gateway.origin}/`)
        throw new Error("--url must be Batty's HTTPS origin");
      await checkResponse(`${gateway.origin}/api/maintenance/status`);
      const reply = await checkResponse(
        `${mainLoopback(config.port, config.host)}/api/maintenance-model`,
        {
          cookie: `${config.cookieName}=${createAuthToken(config.authSecret, 60_000)}`,
        },
      );
      const model = (await reply.json()) as MaintenanceModel;
      const job = jobUnit === undefined ? undefined : await identifyMaintenanceJob(jobUnit);
      const now = Date.now();
      await writeMaintenance(root, {
        id: randomUUID(),
        phase: "offline",
        task,
        context: context || undefined,
        job,
        message: message!,
        progress: progress ?? null,
        startedAt: now,
        updatedAt: now,
        model,
      });
      try {
        const probe = await fetch(`${gateway.origin}/api/bootstrap`, {
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        if (probe.status !== 503 || probe.headers.get("X-Batty-Maintenance") !== "1")
          throw new Error("The public Batty gateway is not routing traffic to maintenance");
      } catch (error) {
        await clearMaintenance(root);
        throw error;
      }
    } else {
      if (!state) throw new Error("Batty is not in maintenance mode");
      if (action === "exit") {
        if (state.phase !== "starting") throw new Error("Run maintenance allow-start first");
        const config = await loadConfig(root);
        const reply = await checkResponse(`${mainLoopback(config.port, config.host)}/healthz`);
        if (!((await reply.json()) as { ok?: boolean }).ok)
          throw new Error("Batty did not report healthy");
        await clearMaintenance(root);
      } else {
        const job = jobUnit === undefined ? state.job : await identifyMaintenanceJob(jobUnit);
        await writeMaintenance(root, {
          ...state,
          phase:
            action === "allow-start" ? "starting" : action === "hold" ? "offline" : state.phase,
          task: task ?? state.task,
          context: context === undefined ? state.context : context || undefined,
          job,
          message: message ?? state.message,
          progress: progress === undefined ? state.progress : progress,
          updatedAt: Date.now(),
        });
      }
    }
    const updated = await readMaintenance(root);
    if (updated) delete updated.context;
    console.log(JSON.stringify(updated ?? { active: false }));
  } finally {
    await unlock();
  }
}

async function checkResponse(url: string, headers?: HeadersInit): Promise<Response> {
  const response = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response;
}
