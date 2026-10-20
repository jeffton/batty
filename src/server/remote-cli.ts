import { parseArgs } from "node:util";
import { loadConfig } from "./config";
import { createAuthToken } from "./auth";

export const remoteHelp = `Usage: batty2 [--root /var/lib/batty2] remote RESOURCE ACTION [options]
  remote grant add --label TEXT
  remote grant list
  remote grant revoke --id ID
  remote connection add --id ID --label TEXT --url URL --token-stdin
  remote connection list
  remote connection remove --id ID
Options:
  --token TOKEN  Alternative to --token-stdin; may expose the token in shell history.
Outputs JSON. Grant add returns the new bearer token once. Keep that output private.
Uses the running local Batty service; changes take effect without restart.
`;

async function stdinToken(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let token = "";
  for await (const chunk of process.stdin) token += chunk;
  return token.trim();
}

export async function parseRemoteArgs(args: string[], readToken = stdinToken) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      root: { type: "string", default: "/var/lib/batty2" },
      help: { type: "boolean" },
      id: { type: "string" },
      label: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
      "token-stdin": { type: "boolean" },
    },
  });
  if (values.help) return { root: values.root, help: true, body: {} };
  const [command, resource, action, extra] = positionals;
  const actions = [
    "grant-add",
    "grant-list",
    "grant-revoke",
    "connection-add",
    "connection-list",
    "connection-remove",
  ];
  const operation = `${resource}-${action}`;
  if (command !== "remote" || extra || !actions.includes(operation)) throw new Error(remoteHelp);
  const allowed: Record<string, string[]> = {
    "grant-add": ["label"],
    "grant-list": [],
    "grant-revoke": ["id"],
    "connection-add": ["id", "label", "url", "token", "token-stdin"],
    "connection-list": [],
    "connection-remove": ["id"],
  };
  for (const flag of ["id", "label", "url", "token", "token-stdin"] as const) {
    if (values[flag] !== undefined && !allowed[operation]!.includes(flag)) {
      throw new Error(`--${flag} is not valid for ${resource} ${action}`);
    }
  }
  const body: Record<string, string> = { action: operation };
  for (const field of allowed[operation]!.filter(
    (name) => name !== "token" && name !== "token-stdin",
  )) {
    const value = values[field as "id" | "label" | "url"];
    if (!value?.trim()) throw new Error(`--${field} is required`);
    body[field] = value;
  }
  if (operation === "connection-add") {
    if ((values.token !== undefined) === !!values["token-stdin"]) {
      throw new Error("Choose exactly one of --token or --token-stdin");
    }
    const token = values["token-stdin"] ? await readToken() : values.token!;
    if (!token.trim()) throw new Error("Remote token is required");
    body.token = token.trim();
  }
  return { root: values.root, help: false, body };
}

export async function runRemoteCli(args: string[]) {
  const input = await parseRemoteArgs(args);
  if (input.help) {
    process.stdout.write(remoteHelp);
    return;
  }
  const config = await loadConfig(input.root);
  const localHost =
    config.host === "0.0.0.0" ? "127.0.0.1" : config.host === "::" ? "::1" : config.host;
  if (!["127.0.0.1", "::1", "localhost"].includes(localHost)) {
    throw new Error("Remote CLI requires a loopback BATTY_HOST");
  }
  const host = localHost === "::1" ? "[::1]" : localHost;
  const response = await fetch(`http://${host}:${config.port}/api/remotes`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
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

export function isRemoteCommand(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--root") {
      i++;
      continue;
    }
    if (arg.startsWith("--root=") || arg === "--help") continue;
    return arg === "remote";
  }
  return false;
}
