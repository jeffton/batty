#!/usr/bin/env node
import path from "node:path";
import { loadConfig, resolveBattyDir } from "./config";
import { buildCronJobSummary, CronStore } from "./cron";
import { formatSetupCode, PasskeyAuthService } from "./passkeys";
import type { CreateCronJobInput, CronJobScheduleInput, UpdateCronJobInput } from "@/shared/types";

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const keyValue = arg.slice(2);
    const [key, inlineValue] = keyValue.split("=", 2);
    if (!key) {
      continue;
    }

    if (inlineValue != null) {
      flags[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return { positionals, flags };
}

function stringFlag(
  flags: Record<string, string | boolean>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = flags[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function booleanFlag(flags: Record<string, string | boolean>, ...names: string[]): boolean {
  return names.some((name) => flags[name] === true);
}

function requireString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function usage(): string {
  return [
    "batty <command>",
    "",
    "Global:",
    "  --root <path>              Batty root, e.g. /root/github",
    "",
    "Commands:",
    "  auth code                  Print a fresh one-time 8 char auth code",
    "  cron list [--workspace ID] [--json]",
    "  cron add --workspace ID --prompt TEXT --model ID --thinking LEVEL (--in DUR | --at ISO | --every DUR | --cron EXPR) [--tz IANA]",
    "  cron edit <jobId> [fields...]",
    "  cron rm <jobId>",
    "",
    "Examples:",
    "  batty --root /root/github auth code",
    '  batty --root /root/github cron add --workspace batty --prompt "Check CI" --model openai/gpt-5 --thinking medium --every 1h',
    '  batty --root /root/github cron add --workspace batty --prompt "Morning summary" --model anthropic/claude-sonnet-4 --thinking low --cron "0 8 * * 1-5" --tz Europe/Copenhagen',
    '  batty --root /root/github cron edit abc123 --prompt "Updated prompt" --thinking high',
  ].join("\n");
}

function resolveRootFromParsedArgs(parsed: ParsedArgs): string {
  const explicitRoot = stringFlag(parsed.flags, "root");
  if (explicitRoot) {
    return resolveBattyDir([explicitRoot]);
  }

  const envRoot = process.env.BATTY_ROOT?.trim();
  if (envRoot) {
    return resolveBattyDir([envRoot]);
  }

  const cwd = process.cwd();
  if (path.basename(cwd) === "batty") {
    return path.dirname(cwd);
  }

  throw new Error("Missing Batty root. Pass --root /path/to/root or set BATTY_ROOT.");
}

function buildSchedule(flags: Record<string, string | boolean>): CronJobScheduleInput | undefined {
  const at = stringFlag(flags, "at");
  const inValue = stringFlag(flags, "in");
  const every = stringFlag(flags, "every");
  const expression = stringFlag(flags, "cron");
  const timezone = stringFlag(flags, "tz", "timezone");

  const modes = [Boolean(at || inValue), Boolean(every), Boolean(expression)].filter(
    Boolean,
  ).length;
  if (modes === 0) {
    return undefined;
  }
  if (modes > 1) {
    throw new Error("Choose exactly one schedule: --at/--in, --every, or --cron");
  }

  if (at || inValue) {
    return {
      kind: "at",
      at,
      in: inValue,
    };
  }
  if (every) {
    return {
      kind: "every",
      every,
    };
  }
  return {
    kind: "cron",
    expression: requireString(expression, "--cron"),
    timezone,
  };
}

async function handleAuthCode(root: string): Promise<void> {
  const config = await loadConfig(root);
  const passkeys = new PasskeyAuthService(config.battyDir, config.authSecret);
  const setup = await passkeys.issueSetupCode("batty-cli");
  console.log(`Setup code: ${formatSetupCode(setup.code)}`);
  console.log(`Expires at: ${new Date(setup.expiresAt).toISOString()}`);
}

async function handleCronList(root: string, parsed: ParsedArgs): Promise<void> {
  const config = await loadConfig(root);
  const store = new CronStore(config);
  const workspaceId = stringFlag(parsed.flags, "workspace");
  const jobs = await store.listJobs(workspaceId);

  if (booleanFlag(parsed.flags, "json")) {
    console.log(JSON.stringify(jobs, null, 2));
    return;
  }

  if (jobs.length === 0) {
    console.log(workspaceId ? `No cron jobs in workspace ${workspaceId}.` : "No cron jobs.");
    return;
  }

  console.log(jobs.map(buildCronJobSummary).join("\n\n---\n\n"));
}

async function handleCronAdd(root: string, parsed: ParsedArgs): Promise<void> {
  const config = await loadConfig(root);
  const store = new CronStore(config);
  const input: CreateCronJobInput = {
    workspaceId: requireString(stringFlag(parsed.flags, "workspace"), "--workspace"),
    prompt: requireString(stringFlag(parsed.flags, "prompt"), "--prompt"),
    model: requireString(stringFlag(parsed.flags, "model"), "--model"),
    thinkingLevel: requireString(stringFlag(parsed.flags, "thinking"), "--thinking"),
    schedule:
      buildSchedule(parsed.flags) ??
      (() => {
        throw new Error("A schedule is required: --at/--in, --every, or --cron");
      })(),
  };

  const job = await store.createJob(input);
  console.log(`Created cron job.\n\n${buildCronJobSummary(job)}`);
}

async function handleCronEdit(root: string, parsed: ParsedArgs): Promise<void> {
  const jobId = requireString(parsed.positionals[2], "jobId");
  const config = await loadConfig(root);
  const store = new CronStore(config);
  const schedule = buildSchedule(parsed.flags);
  const patch: UpdateCronJobInput = {
    workspaceId: stringFlag(parsed.flags, "workspace"),
    prompt: stringFlag(parsed.flags, "prompt"),
    model: stringFlag(parsed.flags, "model"),
    thinkingLevel: stringFlag(parsed.flags, "thinking"),
    schedule,
  };

  if (
    patch.workspaceId == null &&
    patch.prompt == null &&
    patch.model == null &&
    patch.thinkingLevel == null &&
    patch.schedule == null
  ) {
    throw new Error("No changes provided for cron edit");
  }

  const job = await store.updateJob(jobId, patch);
  console.log(`Updated cron job.\n\n${buildCronJobSummary(job)}`);
}

async function handleCronRemove(root: string, parsed: ParsedArgs): Promise<void> {
  const jobId = requireString(parsed.positionals[2], "jobId");
  const config = await loadConfig(root);
  const store = new CronStore(config);
  const job = await store.deleteJob(jobId);
  console.log(`Removed cron job ${job.id} from workspace ${job.workspaceId}.`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.positionals[0];
  const subcommand = parsed.positionals[1];

  if (!command || booleanFlag(parsed.flags, "help", "h")) {
    console.log(usage());
    return;
  }

  const root = resolveRootFromParsedArgs(parsed);

  if (command === "auth" && subcommand === "code") {
    await handleAuthCode(root);
    return;
  }

  if (command === "cron" && subcommand === "list") {
    await handleCronList(root, parsed);
    return;
  }

  if (command === "cron" && subcommand === "add") {
    await handleCronAdd(root, parsed);
    return;
  }

  if (command === "cron" && subcommand === "edit") {
    await handleCronEdit(root, parsed);
    return;
  }

  if (
    command === "cron" &&
    (subcommand === "rm" || subcommand === "remove" || subcommand === "delete")
  ) {
    await handleCronRemove(root, parsed);
    return;
  }

  throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
