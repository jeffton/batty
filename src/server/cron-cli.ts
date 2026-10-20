import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config";
import { createAuthToken } from "./auth";
import { isRemoteCommand, runRemoteCli } from "./remote-cli";

export const help = `Usage: batty2 [--root /var/lib/batty2] cron ACTION [JOB_ID] [options]
Actions: add, update, remove, list, get, import, list-running, list-run-logs, stop-running
Options:
  --workspace ID --title TEXT --prompt TEXT --model PROVIDER/MODEL --thinking LEVEL
  --in DURATION | --at ISO_DATE | --every DURATION | --cron EXPRESSION
  --timezone ZONE
  --delivery direct|assistant --enabled true|false --run-id ID --limit NUMBER
  --json FILE  Read request fields from JSON file (use - for stdin).
list returns compact summaries across all workspaces; --workspace ID filters them.
get JOB_ID returns full details including prompt.
add requires --title, --prompt and a schedule.
Outputs JSON. Uses the running Batty2 service; does not start a scheduler.
For remote instance provisioning: batty2 remote --help
`;

export async function parseCronArgs(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      root: { type: "string", default: "/var/lib/batty2" },
      help: { type: "boolean" },
      workspace: { type: "string" },
      title: { type: "string" },
      prompt: { type: "string" },
      model: { type: "string" },
      thinking: { type: "string" },
      in: { type: "string" },
      at: { type: "string" },
      every: { type: "string" },
      cron: { type: "string" },
      timezone: { type: "string" },
      enabled: { type: "string" },
      delivery: { type: "string" },
      "run-id": { type: "string" },
      limit: { type: "string" },
      json: { type: "string" },
    },
  });
  if (values.help) return { root: values.root, help: true, body: {} };
  const [command, action, jobId, extra] = positionals;
  if (command !== "cron" || !action || extra) throw new Error(help);
  let jsonText = "";
  if (values.json === "-") {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) jsonText += chunk;
  } else if (values.json) {
    jsonText = await fs.readFile(values.json, "utf8");
  }
  const body: Record<string, unknown> = values.json ? JSON.parse(jsonText) : {};
  body.action = action;
  if (jobId) body.jobId = jobId;
  for (const [flag, field] of [
    ["workspace", "workspaceId"],
    ["title", "title"],
    ["prompt", "prompt"],
    ["model", "model"],
    ["thinking", "thinkingLevel"],
    ["run-id", "runId"],
  ] as const) {
    if (values[flag] !== undefined) body[field] = values[flag];
  }
  if (values.delivery !== undefined) {
    if (!["direct", "assistant"].includes(values.delivery))
      throw new Error("--delivery requires direct or assistant");
    body.delivery = values.delivery;
  }
  if (values.enabled !== undefined) {
    if (!["true", "false"].includes(values.enabled))
      throw new Error("--enabled requires true or false");
    body.enabled = values.enabled === "true";
  }
  if (values.limit !== undefined) {
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("--limit requires a positive integer");
    body.limit = limit;
  }
  const schedules = ["in", "at", "every", "cron"] as const;
  const selected = schedules.filter((key) => values[key] !== undefined);
  if (selected.length > 1) throw new Error("Choose only one schedule");
  if (selected.length) {
    const key = selected[0]!;
    body.schedule =
      key === "cron"
        ? { kind: "cron", expression: values.cron, timezone: values.timezone }
        : { kind: key === "in" ? "at" : key, [key]: values[key] };
  } else if (values.timezone) throw new Error("--timezone requires --cron");
  return { root: values.root, help: false, body };
}

export async function runCronCli(args: string[]) {
  if (isRemoteCommand(args)) return runRemoteCli(args);
  const input = await parseCronArgs(args);
  if (input.help) {
    process.stdout.write(help);
    return;
  }
  const config = await loadConfig(input.root);
  const localHost =
    config.host === "0.0.0.0" ? "127.0.0.1" : config.host === "::" ? "::1" : config.host;
  if (!["127.0.0.1", "::1", "localhost"].includes(localHost))
    throw new Error("Cron CLI requires a loopback BATTY_HOST");
  const host = localHost === "::1" ? "[::1]" : localHost;
  const response = await fetch(`http://${host}:${config.port}/api/cron`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${config.cookieName}=${createAuthToken(config.authSecret, 60000)}`,
    },
    body: JSON.stringify(input.body),
  });
  const result = await response.text();
  if (!response.ok) throw new Error(`Batty2 ${response.status}: ${result}`);
  process.stdout.write(`${JSON.stringify(JSON.parse(result), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(await fs.realpath(process.argv[1])).href) {
  runCronCli(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
