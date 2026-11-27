import { promisify } from "node:util";
import { expect, test, vi } from "vite-plus/test";
import { identifyMaintenanceJob, maintenanceJob } from "./maintenance-diagnostics";

const exec = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: Object.assign(() => {}, { [promisify.custom]: exec }),
}));

const unit = "batty2-test-migration.service";

function status(invocation: string, active: string, sub = "running", loadState = "loaded") {
  return {
    stdout: `LoadState=${loadState}\nInvocationID=${invocation}\nActiveState=${active}\nSubState=${sub}\nResult=success\nExecMainStatus=0\n`,
  };
}

test("a job diagnosis stays tied to the operator-linked invocation", async () => {
  exec.mockResolvedValueOnce(status("first", "activating"));
  const job = await identifyMaintenanceJob(unit);
  expect(job).toEqual({ unit, invocationId: "first" });
  exec.mockResolvedValueOnce(status("first", "active"));
  expect(await maintenanceJob(job)).toEqual({
    unit,
    available: true,
    ActiveState: "active",
    SubState: "running",
  });
  exec.mockResolvedValueOnce(status("first", "reloading", "reload"));
  expect(await maintenanceJob(job)).not.toHaveProperty("Result");
  exec.mockResolvedValueOnce(status("first", "active", "exited"));
  expect(await maintenanceJob(job)).toMatchObject({ Result: "success", ExecMainStatus: "0" });
  exec.mockResolvedValueOnce(status("replacement", "active"));
  expect(await maintenanceJob(job)).toEqual({ unit, available: false });
  exec.mockResolvedValueOnce(status("", "inactive", "dead", "not-found"));
  expect(await maintenanceJob(job)).toEqual({ unit, available: false });
});

test("the operator can only link an existing invocation", async () => {
  exec.mockClear();
  await expect(identifyMaintenanceJob("--all")).rejects.toThrow("name a systemd service");
  expect(exec).not.toHaveBeenCalled();
  exec.mockResolvedValueOnce(status("", "inactive", "dead", "not-found"));
  await expect(identifyMaintenanceJob(unit)).rejects.toThrow("No running systemd invocation");
  exec.mockResolvedValueOnce(status("finished", "active", "exited"));
  await expect(identifyMaintenanceJob(unit)).rejects.toThrow("No running systemd invocation");
});
