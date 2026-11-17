import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Socket } from "node:net";

// This supervisor is outside the test worker. A worker killed by the OOM killer
// cannot run finally/exit hooks, but the kernel still closes its ownership pipe.
// The supervisor owns a fresh process group, never a PID discovered by scanning.
export const BROWSER_OWNER_SUPERVISOR = String.raw`
const { spawn } = require('node:child_process');
const child = spawn(process.argv[1], process.argv.slice(2), {
  detached: true, stdio: ['ignore', 'inherit', 'inherit'],
});
let stopping = false;
let timer;
const signal = value => {
  if (!child.pid) return;
  try { process.kill(-child.pid, value); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
};
const stop = () => {
  if (stopping) return;
  stopping = true;
  signal('SIGTERM');
  timer = setTimeout(() => signal('SIGKILL'), 1000);
};
process.stdin.resume();
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('error', error => {
  console.error(error);
  process.exitCode = 1;
  process.stdin.destroy();
});
child.on('exit', (code, reason) => {
  clearTimeout(timer);
  // Reap descendants even if the application's main process exited first.
  signal('SIGKILL');
  process.stdin.destroy();
  process.exitCode = code ?? (reason ? 1 : 0);
});
`;

const ownedChildren = new Set<ChildProcess>();
const ownedStops = new WeakMap<ChildProcess, Promise<void>>();

/** Keep the pipe open for exactly this Node owner's lifetime, without keeping it alive. */
export function retainBrowserOwner(child: ChildProcess): ChildProcess {
  ownedChildren.add(child);
  (child.stdin as Socket).unref();
  const release = () => {
    child.stdin!.destroy();
    ownedChildren.delete(child);
    child.removeListener("exit", release);
    child.removeListener("error", release);
  };
  child.once("exit", release);
  child.once("error", release);
  // A failed sudo launch may close its input before emitting exit.
  child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE" && error.code !== "ECONNRESET") throw error;
  });
  return child;
}

/** Do not SIGKILL the supervisor before it has escalated its own application group. */
export function stopBrowserOwner(child: ChildProcess): Promise<void> | undefined {
  if (!ownedChildren.has(child)) return undefined;
  let stopped = ownedStops.get(child);
  if (!stopped) {
    stopped = new Promise<void>((resolve, reject) => {
      const exited = () => {
        clearTimeout(deadline);
        resolve();
      };
      const deadline = setTimeout(() => {
        child.removeListener("exit", exited);
        reject(new Error(`Browser owner ${child.pid} did not finish application cleanup`));
      }, 2000);
      child.once("exit", exited);
      child.stdin!.end();
    });
    ownedStops.set(child, stopped);
  }
  return stopped;
}

export function browserOwnerOptions(options: SpawnOptions): SpawnOptions {
  return {
    ...options,
    stdio: [
      "pipe",
      options.stdio instanceof Array ? options.stdio[1]! : "inherit",
      options.stdio instanceof Array ? options.stdio[2]! : "inherit",
    ],
  };
}

/** Root already has permission to supervise its own application group. */
export function spawnOwnedProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  return retainBrowserOwner(
    spawn(
      process.execPath,
      ["-e", BROWSER_OWNER_SUPERVISOR, command, ...args],
      browserOwnerOptions(options),
    ),
  );
}
