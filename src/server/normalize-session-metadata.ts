import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const VERSION = 1;
const MIGRATION = "batty-agent-session-migration";
const OLD_RESULT = "batty-agent-session-operation-result";
const COMPLETION = "batty-subagent-completion";
const SUBAGENT = "batty-subagent-session";
const CRON_BINDING = "batty-cron-run-session";
const CRON_EXECUTION = "batty-cron-execution";
const OPERATION = "batty-session-operation";

export interface SessionMetadataNormalizationSummary {
  scanned: number;
  convertedFiles: number;
  unchangedFiles: number;
  dryRun: boolean;
  alreadyNormalized?: boolean;
  backupPath?: string;
  tools: number;
  history: number;
  cronResults: number;
  subagentResults: number;
  operations: number;
  boundedCompletions: number;
}

type ObjectValue = Record<string, any>;
interface IndexedEntry {
  id: string;
  parentId: string | null;
  type: string;
  customType?: string;
  data?: ObjectValue;
  cronRunId?: string;
  raw?: ObjectValue;
  line: number;
}
interface Plan {
  hash: string;
  replacements: Map<number, string>;
  counts: Pick<
    SessionMetadataNormalizationSummary,
    "tools" | "history" | "cronResults" | "subagentResults" | "operations" | "boundedCompletions"
  >;
}

function object(value: unknown, description: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${description}`);
  return value as ObjectValue;
}

/** Retain exact source lines, including their newline style; never serialize message/image lines. */
async function* sourceLines(file: string, hash?: ReturnType<typeof createHash>) {
  const stream = createReadStream(file, { encoding: "utf8" });
  let pending = "";
  for await (const chunk of stream) {
    const text = chunk as string;
    hash?.update(text);
    pending += text;
    let start = 0;
    let end: number;
    while ((end = pending.indexOf("\n", start)) !== -1) {
      yield pending.slice(start, end + 1);
      start = end + 1;
    }
    pending = pending.slice(start);
  }
  if (pending) yield pending;
}

async function sessionFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sessionFiles(file)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
  }
  return files.sort();
}

async function prepare(file: string): Promise<Plan> {
  const hash = createHash("sha256");
  const entries = new Map<string, IndexedEntry>();
  const candidates: IndexedEntry[] = [];
  const replacements = new Map<number, string>();
  const counts = {
    tools: 0,
    history: 0,
    cronResults: 0,
    subagentResults: 0,
    operations: 0,
    boundedCompletions: 0,
  };
  let header: ObjectValue | undefined;
  let lineNumber = 0;
  for await (const line of sourceLines(file, hash)) {
    lineNumber++;
    if (!line.trim()) continue;
    const raw = object(JSON.parse(line), `JSONL record at line ${lineNumber}`);
    if (!header) {
      if (raw.type !== "session" || raw.version !== 3 || typeof raw.id !== "string")
        throw new Error("Expected native Pi session version 3");
      header = raw;
      continue;
    }
    if (
      typeof raw.id !== "string" ||
      entries.has(raw.id) ||
      (raw.parentId !== null && typeof raw.parentId !== "string") ||
      (raw.parentId !== null && !entries.has(raw.parentId))
    )
      throw new Error(`Invalid entry identity or parent at line ${lineNumber}: ${raw.id}`);
    const entry: IndexedEntry = {
      id: raw.id,
      parentId: raw.parentId,
      type: raw.type,
      line: lineNumber,
    };
    if (raw.type === "custom") {
      entry.customType = raw.customType;
      if (
        [
          MIGRATION,
          OLD_RESULT,
          COMPLETION,
          SUBAGENT,
          CRON_BINDING,
          CRON_EXECUTION,
          OPERATION,
        ].includes(raw.customType)
      )
        entry.data = object(raw.data, `${raw.customType} data`);
      if ([MIGRATION, OLD_RESULT, COMPLETION].includes(raw.customType)) {
        entry.raw = raw;
        candidates.push(entry);
      }
    } else if (
      raw.type === "custom_message" &&
      raw.customType === "batty-runtime-notice:cron" &&
      typeof raw.details?.cron?.runId === "string"
    ) {
      entry.cronRunId = raw.details.cron.runId;
    }
    entries.set(entry.id, entry);
  }
  if (!header) throw new Error("Missing session header");

  function endpoint(value: unknown, description: string): string | null {
    if (value === null) return null;
    if (typeof value !== "string" || !entries.has(value))
      throw new Error(`Missing or invalid ${description}: ${String(value)}`);
    return value;
  }
  function ancestors(end: string | null): IndexedEntry[] {
    const result: IndexedEntry[] = [];
    while (end !== null) {
      const entry = entries.get(end)!;
      result.push(entry);
      end = entry.parentId;
    }
    return result;
  }
  function validateBounds(start: unknown, end: unknown, requireAncestry = true) {
    const startEntryId = endpoint(start, "result start entry");
    const endEntryId = endpoint(end, "result end entry");
    const branch = ancestors(endEntryId);
    if (
      requireAncestry &&
      startEntryId !== null &&
      !branch.some((entry) => entry.id === startEntryId)
    )
      throw new Error(`Result start ${startEntryId} is not an ancestor of end ${endEntryId}`);
    return { startEntryId, endEntryId, branch };
  }
  function replace(entry: IndexedEntry, customType: string, data: ObjectValue) {
    const raw = { ...entry.raw!, customType, data };
    // Newline style is restored while writing the individual source line.
    replacements.set(entry.line, JSON.stringify(raw));
  }
  function ownSubagent(entry: IndexedEntry) {
    return entry.customType === SUBAGENT && entry.data?.sessionId === header!.id;
  }
  function belongsToCron(branch: IndexedEntry[], operationId: string) {
    // A full-context child can inherit its parent's cron binding. Only its closest
    // cron/subagent owner marker owns detached runs; an explicit inline notice also binds a run.
    const owner = branch.find(
      (entry) => entry.customType === SUBAGENT || entry.customType === CRON_BINDING,
    );
    return (
      (owner?.customType === CRON_BINDING && owner.data?.runId === operationId) ||
      branch.some((entry) => entry.cronRunId === operationId)
    );
  }

  for (const entry of candidates) {
    const data = entry.data!;
    if (entry.customType === MIGRATION) {
      const originalTipId = endpoint(data.originalTipId, "original tip");
      if (!Array.isArray(data.branchTips)) throw new Error("Invalid migration branch tips");
      for (const tip of data.branchTips) {
        if (typeof tip.branch !== "string") throw new Error("Invalid migration branch name");
        endpoint(tip.tipId, "branch tip");
      }
      const history = {
        originalTipId,
        branchTips: data.branchTips,
        sourceVersion: data.sourceVersion,
      };
      if (data.configuration !== undefined) {
        const activeToolNames = data.configuration?.activeToolNames;
        if (
          !Array.isArray(activeToolNames) ||
          activeToolNames.some((name) => typeof name !== "string")
        )
          throw new Error("Invalid migrated active tool names");
        // Inert history accompanies tool state so the original entry identity/tree stays intact.
        replace(entry, "batty-session-tools", { activeToolNames, history });
        counts.tools++;
      } else {
        replace(entry, "batty-session-history", history);
        counts.history++;
      }
    } else if (entry.customType === OLD_RESULT) {
      if (
        typeof data.operationId !== "string" ||
        !["run", "compaction", "navigation"].includes(data.kind) ||
        !["completed", "declined", "failed", "aborted"].includes(data.status) ||
        !Number.isSafeInteger(data.startedAt) ||
        !Number.isSafeInteger(data.endedAt) ||
        (data.error !== undefined &&
          (typeof data.error?.code !== "string" || typeof data.error?.message !== "string"))
      )
        throw new Error(`Invalid historical operation result ${entry.id}`);
      const { startEntryId, endEntryId, branch } = validateBounds(
        data.fromTipId,
        data.tipId,
        data.kind === "run",
      );
      const status = data.status === "declined" ? "failed" : data.status;
      if (data.kind === "run" && belongsToCron(branch, data.operationId)) {
        replace(entry, CRON_EXECUTION, {
          runId: data.operationId,
          startEntryId,
          endEntryId,
          status,
          ...(data.error ? { error: data.error.message } : {}),
        });
        counts.cronResults++;
      } else if (data.kind === "run" && branch.some(ownSubagent)) {
        replace(entry, COMPLETION, {
          startEntryId,
          endEntryId,
          status,
          ...(data.status !== "completed" || data.error
            ? { error: data.error?.message ?? `Subagent ${data.status}` }
            : {}),
        });
        counts.subagentResults++;
      } else {
        replace(entry, OPERATION, {
          operationId: data.operationId,
          kind: data.kind,
          status: data.status,
          startEntryId,
          endEntryId,
          ...(data.error ? { error: data.error } : {}),
          startedAt: data.startedAt,
          endedAt: data.endedAt,
        });
        counts.operations++;
      }
    } else if (entry.customType === COMPLETION) {
      if (!Object.hasOwn(data, "startEntryId") && !Object.hasOwn(data, "endEntryId")) {
        const previous = ancestors(entry.parentId).find(
          (ancestor) =>
            ancestor.customType === COMPLETION ||
            (ancestor.customType === OLD_RESULT && ancestor.data?.kind === "run") ||
            ancestor.customType === SUBAGENT,
        );
        if (!previous) throw new Error(`Missing subagent completion start marker ${entry.id}`);
        const bounds = validateBounds(previous.id, entry.parentId);
        if (!["completed", "failed", "aborted"].includes(data.status))
          throw new Error(`Invalid subagent completion status ${entry.id}`);
        replace(entry, COMPLETION, {
          ...data,
          startEntryId: bounds.startEntryId,
          endEntryId: bounds.endEntryId,
        });
        counts.boundedCompletions++;
      } else {
        validateBounds(data.startEntryId, data.endEntryId);
      }
    }
  }
  // Already-canonical receipts are validated too, including partially converted datasets.
  for (const entry of entries.values()) {
    if (entry.customType === CRON_EXECUTION || entry.customType === OPERATION)
      validateBounds(
        entry.data!.startEntryId,
        entry.data!.endEntryId,
        entry.customType === CRON_EXECUTION
          ? entry.data!.status !== "running"
          : entry.data!.kind === "run",
      );
  }
  return { hash: hash.digest("hex"), replacements, counts };
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function syncDirectory(directory: string): Promise<void> {
  // Node cannot open directory handles for fsync on Windows; file contents are still flushed.
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(file: string): Promise<void> {
  const handle = await fs.open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeNormalized(source: string, destination: string, plan: Plan, mode: number) {
  const handle = await fs.open(destination, "wx", mode);
  try {
    let lineNumber = 0;
    for await (const line of sourceLines(source)) {
      lineNumber++;
      const replacement = plan.replacements.get(lineNumber);
      const newline = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
      await handle.writeFile(replacement === undefined ? line : replacement + newline);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Offline deployment conversion. The caller must stop session writers before non-dry runs. */
export async function normalizeSessionMetadata(
  root: string,
  options: { dryRun?: boolean } = {},
): Promise<SessionMetadataNormalizationSummary> {
  const battyDirectory = path.resolve(root, ".batty");
  const directory = path.join(battyDirectory, "sessions");
  const marker = path.join(battyDirectory, "session-metadata-normalization.json");
  const summary: SessionMetadataNormalizationSummary = {
    scanned: 0,
    convertedFiles: 0,
    unchangedFiles: 0,
    dryRun: options.dryRun ?? false,
    tools: 0,
    history: 0,
    cronResults: 0,
    subagentResults: 0,
    operations: 0,
    boundedCompletions: 0,
  };
  try {
    const completed = object(JSON.parse(await fs.readFile(marker, "utf8")), "normalization marker");
    if (completed.version === VERSION) return { ...summary, alreadyNormalized: true };
    throw new Error(
      `Unsupported session metadata normalization marker version: ${completed.version}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let files: string[];
  try {
    files = await sessionFiles(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    files = [];
  }
  summary.scanned = files.length;
  // Keep only file hashes between passes, not 10GB of source or even all replacement plans.
  const validated: Array<{ file: string; hash: string; changed: boolean }> = [];
  const errors: Error[] = [];
  for (const file of files) {
    try {
      const plan = await prepare(file);
      const changed = plan.replacements.size > 0;
      validated.push({ file, hash: plan.hash, changed });
      if (changed) summary.convertedFiles++;
      else summary.unchangedFiles++;
      for (const key of Object.keys(plan.counts) as Array<keyof Plan["counts"]>)
        summary[key] += plan.counts[key];
    } catch (error) {
      errors.push(
        new Error(`Session metadata validation failed for ${file}: ${(error as Error).message}`),
      );
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      `Session metadata prevalidation failed for ${errors.length} file(s):\n${errors.map((error) => error.message).join("\n")}`,
    );
  if (summary.dryRun) return summary;
  for (const { file, hash } of validated) {
    if ((await hashFile(file)) !== hash)
      throw new Error(`Session changed during metadata validation: ${file}`);
  }
  const changed = validated.filter((item) => item.changed);
  if (changed.length) {
    const backupPath = path.join(
      battyDirectory,
      "session-metadata-normalization-backups",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
    );
    const backupDirectories = new Set<string>();
    for (const { file, hash } of changed) {
      const backup = path.join(backupPath, path.relative(directory, file));
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.copyFile(file, backup, fs.constants.COPYFILE_EXCL);
      await syncFile(backup);
      if ((await hashFile(backup)) !== hash)
        throw new Error(`Session changed while backing up metadata: ${file}`);
      for (let parent = path.dirname(backup); ; parent = path.dirname(parent)) {
        backupDirectories.add(parent);
        if (parent === battyDirectory) break;
      }
    }
    for (const parent of [...backupDirectories].sort((a, b) => b.length - a.length))
      await syncDirectory(parent);
    summary.backupPath = backupPath;
    for (const { file, hash } of changed) {
      if ((await hashFile(file)) !== hash)
        throw new Error(`Session changed before metadata replacement: ${file}`);
      const backup = path.join(backupPath, path.relative(directory, file));
      const plan = await prepare(backup);
      const temporary = `${file}.metadata-${randomUUID()}.tmp`;
      try {
        await writeNormalized(backup, temporary, plan, (await fs.stat(file)).mode);
        await fs.rename(temporary, file);
        await syncDirectory(path.dirname(file));
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
  }
  await fs.mkdir(battyDirectory, { recursive: true });
  const temporaryMarker = `${marker}.${randomUUID()}.tmp`;
  const markerHandle = await fs.open(temporaryMarker, "wx");
  try {
    await markerHandle.writeFile(
      `${JSON.stringify({ version: VERSION, completedAt: new Date().toISOString(), ...(summary.backupPath ? { backupPath: summary.backupPath } : {}) })}\n`,
    );
    await markerHandle.sync();
  } finally {
    await markerHandle.close();
  }
  await fs.rename(temporaryMarker, marker);
  await syncDirectory(battyDirectory);
  await syncDirectory(path.dirname(battyDirectory));
  return summary;
}
