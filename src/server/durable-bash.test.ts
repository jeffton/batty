// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import * as childProcess from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { persistentBashOperations } from "./durable-bash";
import { bashJobKey, cancelPersistentBashJob } from "./durable-bash-cancel";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

test("failed stdin delivery rejects instead of polling for a missing receipt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-bash-pipe-error-"));
  const { spawn } = await vi.importActual<typeof childProcess>("node:child_process");
  const mock = vi.mocked(childProcess.spawn).mockImplementationOnce(() =>
    spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["pipe", "ignore", "ignore"],
    }),
  );
  try {
    await expect(
      persistentBashOperations(root, "failed-pipe").exec("true", root, {
        env: { BATTY_TEST_VALUE: "x".repeat(4 * 1024 * 1024) },
        onData: () => {},
      }),
    ).rejects.toMatchObject({ code: "EPIPE" });
  } finally {
    mock.mockImplementation(spawn);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32").each([false, true])(
  "supervisor close distinguishes external termination from persisted cancellation before its next poll (%s)",
  async (cancelled) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-bash-cancel-close-"));
    const identity = "cancel-before-monitor";
    const { spawn } = await vi.importActual<typeof childProcess>("node:child_process");
    const mock = vi.mocked(childProcess.spawn).mockImplementationOnce((_command, args, options) => {
      // Suppress only the supervisor's polling callback to deterministically
      // reproduce the child closing before that callback observes cancellation.
      const monitor = "setInterval(()=>{if(fs.existsSync(job.cancelPath))cancel()},20)";
      expect(args?.[1]).toContain(monitor);
      return spawn(
        process.execPath,
        ["-e", args![1]!.replace(monitor, "setInterval(()=>{},20)")],
        options,
      );
    });
    const job = persistentBashOperations(root, identity).exec(
      "echo ready > started; sleep 5",
      root,
      {
        timeout: 5,
        onData: () => {},
      },
    );
    try {
      await vi.waitFor(async () => {
        expect(await fs.readFile(path.join(root, "started"), "utf8")).toBe("ready\n");
      });
      if (cancelled) await cancelPersistentBashJob(root, identity);
      else {
        // The shell can write its marker before the supervisor publishes its PID.
        let pid!: number;
        await vi.waitFor(async () => {
          const receipt = JSON.parse(
            await fs.readFile(path.join(root, bashJobKey(identity), "receipt.json"), "utf8"),
          );
          expect(receipt.status).toBe("running");
          expect(Number.isInteger(receipt.pid)).toBe(true);
          pid = receipt.pid;
        });
        process.kill(-pid, "SIGTERM");
      }
      expect((await job).exitCode).toBe(cancelled ? 130 : 143);
    } finally {
      await cancelPersistentBashJob(root, identity);
      await job;
      mock.mockImplementation(spawn);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "bash receives a large environment over stdin without putting the job in supervisor argv",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-bash-stdin-"));
    const value = "test-only-environment-value-".repeat(4000);
    const command =
      'printf %s "$BATTY_TEST_VALUE" > received; while [ ! -f release ]; do sleep 0.02; done';
    const job = persistentBashOperations(root, "stdin-job").exec(command, root, {
      env: { PATH: process.env.PATH!, BATTY_TEST_VALUE: value },
      timeout: 5,
      onData: () => {},
    });
    try {
      let pid: number | undefined;
      for (let i = 0; i < 200; i++) {
        try {
          const receipt = JSON.parse(
            await fs.readFile(path.join(root, bashJobKey("stdin-job"), "receipt.json"), "utf8"),
          );
          if (receipt.status === "running") {
            pid = receipt.supervisorPid;
            break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await delay(10);
      }
      expect(pid).toBeTypeOf("number");
      const argv = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      expect(argv.slice(1, 2)).toEqual(["-e"]);
      expect(argv).toHaveLength(4); // executable, -e, supervisor source, trailing NUL
      expect(argv.join("\0")).not.toContain(value);
      expect(argv.join("\0")).not.toContain(command);
      expect(argv.join("\0")).not.toContain(root);
      // The running receipt precedes the shell's first write.
      await fs.writeFile(path.join(root, "release"), "");
      expect((await job).exitCode).toBe(0);
      expect(await fs.readFile(path.join(root, "received"), "utf8")).toBe(value);
    } finally {
      await fs.writeFile(path.join(root, "release"), "");
      await job;
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  10000,
);
