import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export function bashJobKey(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}
export function bashCancelPath(jobsDir: string, identity: string): string {
  return path.join(jobsDir, ".cancellations", bashJobKey(identity));
}

export async function cancelPersistentBashJob(jobsDir: string, identity: string): Promise<void> {
  await fs.mkdir(path.join(jobsDir, ".cancellations"), { recursive: true });
  await fs.writeFile(bashCancelPath(jobsDir, identity), "cancelled");
  const directory = path.join(jobsDir, bashJobKey(identity));
  const deadline = Date.now() + 5000;
  let termAt: number | undefined;
  while (true) {
    let receipt: { status: string; pid?: number } | undefined;
    try {
      receipt = JSON.parse(await fs.readFile(path.join(directory, "receipt.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (receipt?.status === "done") return;
    if (!receipt) {
      try {
        await fs.access(path.join(directory, "intent.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
    if (receipt?.pid) {
      const signal = termAt !== undefined && Date.now() - termAt >= 500 ? "SIGKILL" : "SIGTERM";
      try {
        process.kill(-receipt.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      termAt ??= Date.now();
    }
    if (Date.now() >= deadline)
      throw new Error(`Bash cancellation handshake did not finish: ${directory}`);
    await delay(20);
  }
}

/** Explicit user stop, separate from service shutdown/reload. */
export async function cancelPersistentBashJobs(
  jobsDir: string,
  conversationId: number,
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(jobsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async (entry) => {
        let intent: { identity: string };
        try {
          intent = JSON.parse(
            await fs.readFile(path.join(jobsDir, entry.name, "intent.json"), "utf8"),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        if (intent.identity.startsWith(`${conversationId}-`))
          await cancelPersistentBashJob(jobsDir, intent.identity);
      }),
  );
}
