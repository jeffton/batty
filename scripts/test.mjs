import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

// Linux profile fixtures move into /var/lib; /tmp may be a separate filesystem.
const env = { ...process.env };
if (process.platform === "linux") env.TMPDIR ??= "/var/tmp";
const started = performance.now();
// Invoke the CLI's exported JS entrypoint so Windows preserves regex/path arguments.
const child = spawn(
  process.execPath,
  [fileURLToPath(import.meta.resolve("vite-plus/bin")), "test", "--run", ...process.argv.slice(2)],
  { stdio: "inherit", env },
);
const [code, signal] = await once(child, "exit");
console.log(`Test wall time: ${((performance.now() - started) / 1000).toFixed(2)}s`);
process.exitCode = signal ? 1 : code;
