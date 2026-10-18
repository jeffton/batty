import type { ChildProcess } from "node:child_process";

/** Reap a child, escalating once; never wait indefinitely for a broken process. */
export function stopBrowserChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(escalate);
      clearTimeout(deadline);
      child.removeListener("exit", exited);
      if (error) reject(error);
      else resolve();
    };
    const exited = () => finish();
    const signal = (value: NodeJS.Signals) => {
      try {
        child.kill(value);
      } catch (error) {
        finish(error as Error);
      }
    };
    const escalate = setTimeout(() => signal("SIGKILL"), 1000);
    const deadline = setTimeout(
      () => finish(new Error(`Browser child ${child.pid} did not exit after SIGKILL`)),
      2000,
    );
    child.once("exit", exited);
    signal("SIGTERM");
  });
}
