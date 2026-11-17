// @vitest-environment node
import { expect, test } from "vite-plus/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { once } from "node:events";

async function running(pid: number): Promise<boolean> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function fixture(
  mode: "test" | "persistent" | "ephemeral" = "test",
  rootPath = false,
  application = "sleep 600 & echo $$:$!; wait",
) {
  const module = new URL("./browser-privilege.ts", import.meta.url).href;
  const source = `
    import { spawnBrowserProcess } from ${JSON.stringify(module)};
    import { stopBrowserChild } from ${JSON.stringify(new URL("./browser-process.ts", import.meta.url).href)};
    ${rootPath ? "process.getuid = () => 0;" : ""}
    const child = spawnBrowserProcess('/bin/sh', ['-c', ${JSON.stringify(application)}], {
      detached: true, stdio: ['ignore', 'inherit', 'inherit'],
    }, ${mode === "ephemeral"});
    child.unref();
    process.stdin.on("data", async () => { await stopBrowserChild(child); });
    setInterval(() => {}, 1000);
  `;
  const owner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    env: {
      ...process.env,
      VITEST: mode === "test" ? "true" : "",
      BATTY_EPHEMERAL_BROWSER: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  owner.stdout!.on("data", (data: Buffer) => {
    output += data.toString();
  });
  owner.stderr!.on("data", (data: Buffer) => {
    errors += data.toString();
  });
  await expect
    .poll(() => {
      if (owner.exitCode !== null) throw new Error(errors);
      return output;
    })
    .toMatch(/\d+:\d+/);
  const [pid, descendant] = output.trim().split(":").map(Number) as [number, number];
  return { owner, application: pid, descendant };
}

async function terminate(owner: ChildProcess, signal: NodeJS.Signals) {
  const exited = once(owner, "exit");
  owner.kill(signal);
  await exited;
}

// Real separate processes prove that teardown does not depend on finally or exit
// handlers in the killed worker, and that unrelated/user browsers are not scanned.
test.skipIf(process.platform !== "linux").each([
  { signal: "SIGTERM", rootPath: false },
  { signal: "SIGKILL", rootPath: false },
  { signal: "SIGKILL", rootPath: true },
] as const)(
  "test browser groups stop after owner $signal (root path: $rootPath), leaving others alone",
  async ({ signal, rootPath }) => {
    const target = await fixture("test", rootPath);
    const unrelated = await fixture();
    try {
      await terminate(target.owner, signal);
      await expect.poll(() => running(target.application)).toBe(false);
      await expect.poll(() => running(target.descendant)).toBe(false);
      expect(await running(unrelated.application)).toBe(true);
      expect(await running(unrelated.descendant)).toBe(true);
    } finally {
      if (target.owner.exitCode === null && target.owner.signalCode === null)
        await terminate(target.owner, "SIGKILL");
      await terminate(unrelated.owner, "SIGKILL");
      await expect.poll(() => running(unrelated.application)).toBe(false);
    }
  },
  15_000,
);

test.skipIf(process.platform !== "linux")(
  "ephemeral production browsers escalate when their dead owner's children ignore SIGTERM",
  async () => {
    const target = await fixture("ephemeral", false, 'trap "" TERM; sleep 600 & echo $$:$!; wait');
    try {
      await terminate(target.owner, "SIGKILL");
      await expect.poll(() => running(target.application), { timeout: 3000 }).toBe(false);
      await expect.poll(() => running(target.descendant), { timeout: 3000 }).toBe(false);
    } finally {
      if (target.owner.exitCode === null && target.owner.signalCode === null)
        await terminate(target.owner, "SIGKILL");
    }
  },
  15_000,
);

test.skipIf(process.platform !== "linux")(
  "explicit teardown waits for its supervisor to kill a SIGTERM-resistant application",
  async () => {
    const target = await fixture("test", true, 'trap "" TERM; sleep 600 & echo $$:$!; wait');
    try {
      target.owner.stdin!.write("stop");
      await expect.poll(() => running(target.application), { timeout: 3000 }).toBe(false);
      await expect.poll(() => running(target.descendant), { timeout: 3000 }).toBe(false);
      expect(await running(target.owner.pid!)).toBe(true);
    } finally {
      await terminate(target.owner, "SIGKILL");
    }
  },
  15_000,
);

test.skipIf(process.platform !== "linux")(
  "an application exiting first does not leave descendants behind",
  async () => {
    const target = await fixture("test", false, "sleep 600 & echo $$:$!; exit 0");
    try {
      await expect.poll(() => running(target.application)).toBe(false);
      await expect.poll(() => running(target.descendant)).toBe(false);
    } finally {
      await terminate(target.owner, "SIGKILL");
    }
  },
  15_000,
);

test.skipIf(process.platform !== "linux")(
  "persistent production browsers survive their control-plane owner's exit",
  async () => {
    const target = await fixture("persistent");
    try {
      await terminate(target.owner, "SIGKILL");
      expect(await running(target.application)).toBe(true);
      expect(await running(target.descendant)).toBe(true);
    } finally {
      // Only this fixture's freshly created group; never a profile/PID scan.
      const killer = spawn("sudo", [
        "-n",
        "--",
        "/bin/kill",
        "-s",
        "SIGTERM",
        "--",
        `-${target.application}`,
      ]);
      await once(killer, "exit");
      await expect.poll(() => running(target.application)).toBe(false);
    }
  },
  15_000,
);
