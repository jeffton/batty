import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export interface AgentSessionMigrationSummary {
  scanned: number;
  migratedFiles: number;
  unchanged: number;
  entries: number;
  images: number;
  droppedExecutionWrites: number;
  originalBytes: number;
  convertedBytes: number;
  largestConvertedFileBytes: number;
  backupPath?: string;
  dryRun: boolean;
}

type RecordValue = Record<string, any>;
interface PreparedSession {
  content: string;
  entries: number;
  images: number;
  droppedExecutionWrites: number;
}

function record(value: unknown, description: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${description}`);
  return value as RecordValue;
}

function timestamp(value: unknown): string {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`Invalid session timestamp: ${String(value)}`);
  return new Date(value as number).toISOString();
}

async function syncFile(file: string): Promise<void> {
  const handle = await fs.open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not support Node directory handles for fsync. File contents are
  // flushed on every platform; directory-entry durability is provided on Unix.
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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

async function hydrate(value: any, file: string, images: Set<string>): Promise<any> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => hydrate(item, file, images)));
  if (!value || typeof value !== "object") return value;
  if (
    value.type === "image" &&
    typeof value.data === "string" &&
    value.data.startsWith("batty-file:")
  ) {
    const name = value.data.slice("batty-file:".length);
    if (!name || path.basename(name) !== name || name === "." || name === "..")
      throw new Error(`Invalid image reference in ${file}: ${value.data}`);
    if (typeof value.mimeType !== "string") throw new Error(`Missing image MIME type in ${file}`);
    const bytes = await fs.readFile(path.join(`${file}.images`, name));
    const expectedHash = /^([a-f0-9]{64})\./.exec(name)?.[1];
    if (expectedHash && createHash("sha256").update(bytes).digest("hex") !== expectedHash)
      throw new Error(`Corrupt session image in ${file}: ${name}`);
    images.add(name);
    return { ...value, data: bytes.toString("base64") };
  }
  return Object.fromEntries(
    await Promise.all(
      Object.entries(value).map(async ([key, item]) => [key, await hydrate(item, file, images)]),
    ),
  );
}

const executionNamespaces = new Set([
  "pi.lane.state",
  "pi.op.meta",
  "pi.op.state",
  "pi.op.tool_args",
  "pi.op.tool_memo",
  "pi.op.preparation",
  "pi.pending.entry",
  "pi.pending.tool_output",
  "pi.pending.assistant_frame",
]);

async function prepare(
  file: string,
  original: string,
  pathsById: Map<string, string>,
): Promise<PreparedSession | undefined> {
  const lines = original.trimEnd().split("\n");
  const header = record(JSON.parse(lines[0]!), "session header");
  if (header.type === "session" && header.version === 3) {
    for (const line of lines.slice(1)) JSON.parse(line);
    return undefined;
  }
  if (!original.endsWith("\n")) throw new Error(`Unterminated session file: ${file}`);
  if (
    header.v !== 4 ||
    header.kind !== "header" ||
    header.storageVersion !== 1 ||
    typeof header.id !== "string" ||
    typeof header.cwd !== "string"
  )
    throw new Error(`Unsupported session header: ${file}`);
  const createdAt = timestamp(header.createdAt);
  const values = new Map<string, RecordValue>();
  const entries: RecordValue[] = [];
  const usage: RecordValue[] = [];
  let previousSeq = 0;
  let droppedExecutionWrites = 0;
  for (const line of lines.slice(1)) {
    const transaction = JSON.parse(line);
    for (const raw of Array.isArray(transaction) ? transaction : [transaction]) {
      const write = record(raw, "session transaction write");
      if (!Number.isSafeInteger(write.seq) || write.seq <= previousSeq)
        throw new Error(`Invalid session sequence in ${file}: ${write.seq}`);
      previousSeq = write.seq;
      if (write.kind === "entry") entries.push(write);
      else if (write.kind === "usage") usage.push(write);
      else if (write.kind === "value" || write.kind === "list") {
        if (typeof write.namespace !== "string" || typeof write.key !== "string")
          throw new Error(`Invalid stored address in ${file}`);
        if (executionNamespaces.has(write.namespace)) droppedExecutionWrites++;
        else if (write.kind === "list")
          throw new Error(`Unsupported stored list in ${file}: ${write.namespace}`);
        if (write.kind === "value") {
          const address = `${write.namespace}\0${write.key}`;
          if (write.op === "set") values.set(address, write);
          else if (write.op === "delete") values.delete(address);
          else throw new Error(`Unsupported stored value operation in ${file}: ${write.op}`);
        } else if (write.op !== "append" && write.op !== "delete")
          throw new Error(`Unsupported stored list operation in ${file}: ${write.op}`);
      } else throw new Error(`Unsupported transaction kind in ${file}: ${write.kind}`);
    }
  }
  for (const write of values.values()) {
    if (write.namespace === "pi.pending.entry")
      throw new Error(`Pending conversation entry in ${file}: ${write.key}`);
    if (
      write.namespace === "pi.lane.state" &&
      (!Array.isArray(write.value?.inbox) || write.value.inbox.length)
    )
      throw new Error(`Pending or malformed input queue in ${file}: ${write.key}`);
  }
  const byId = new Map<string, RecordValue>();
  const output: RecordValue[] = [];
  const after = new Map<string, string>();
  const images = new Set<string>();
  const ids = new Set(entries.map((entry) => entry.id));
  function synthetic(
    parentId: string | null,
    type: string,
    fields: RecordValue,
    date = createdAt,
  ): string {
    const id = randomUUID();
    if (ids.has(id)) throw new Error(`Migration ID collision: ${id}`);
    ids.add(id);
    output.push({ type, id, parentId, timestamp: date, ...fields });
    return id;
  }
  for (const raw of entries) {
    if (
      typeof raw.id !== "string" ||
      byId.has(raw.id) ||
      (raw.parentId !== null && typeof raw.parentId !== "string")
    )
      throw new Error(`Invalid or duplicate entry identity in ${file}`);
    if (raw.parentId !== null && !byId.has(raw.parentId))
      throw new Error(`Missing entry parent in ${file}: ${raw.parentId}`);
    const date = timestamp(raw.timestamp);
    const {
      kind: _kind,
      seq: _seq,
      retainedTail: _tail,
      ...entry
    } = await hydrate(raw, file, images);
    entry.timestamp = date;
    entry.parentId = raw.parentId === null ? null : after.get(raw.parentId)!;
    if (raw.type === "message") {
      const message = record(entry.message, "session message");
      if (
        ![
          "user",
          "assistant",
          "toolResult",
          "custom",
          "system",
          "bashExecution",
          "compactionSummary",
          "branchSummary",
        ].includes(message.role)
      )
        throw new Error(`Unsupported message role in ${file}: ${message.role}`);
      if (message.role === "assistant" && message.stopReason === "pending")
        throw new Error(`Unsettled assistant message in ${file}: ${raw.id}`);
      if (message.role === "assistant" && message.stopReason === "deferred")
        throw new Error(`Unsupported deferred assistant message in ${file}: ${raw.id}`);
      if (message.role === "custom") {
        if (typeof message.customType !== "string")
          throw new Error(`Invalid custom message in ${file}: ${raw.id}`);
        entry.type = "custom_message";
        entry.customType = message.customType;
        entry.content = message.content;
        entry.display = message.display ?? true;
        entry.details = message.data ?? message.details;
        delete entry.message;
      }
    } else if (raw.type === "custom") {
      if (typeof raw.customType !== "string") throw new Error(`Invalid custom entry in ${file}`);
    } else if (raw.type === "compaction") {
      if (
        !Array.isArray(raw.retainedTail) ||
        typeof raw.summary !== "string" ||
        typeof raw.tokensBefore !== "number"
      )
        throw new Error(`Invalid compaction in ${file}: ${raw.id}`);
      const ancestors: RecordValue[] = [];
      let parentId = raw.parentId;
      while (parentId !== null) {
        const ancestor = byId.get(parentId)!;
        if (ancestor.type === "message") ancestors.push(ancestor);
        parentId = ancestor.parentId;
      }
      ancestors.reverse();
      const tail = raw.retainedTail.length ? ancestors.slice(-raw.retainedTail.length) : [];
      if (
        !isDeepStrictEqual(
          tail.map((ancestor) => ancestor.message),
          raw.retainedTail,
        )
      )
        throw new Error(`Unsupported retained compaction tail in ${file}: ${raw.id}`);
      entry.firstKeptEntryId = tail[0]?.id ?? raw.id;
    } else if (raw.type === "branch_summary") {
      if (typeof raw.summary !== "string" || (raw.fromId !== null && !byId.has(raw.fromId)))
        throw new Error(`Invalid branch summary in ${file}`);
      entry.fromId = raw.fromId ?? "root";
    } else throw new Error(`Unsupported conversation entry in ${file}: ${raw.type}`);
    output.push(entry);
    byId.set(raw.id, raw);
    let childParent = raw.id;
    const writes =
      entry.message?.role === "toolResult" &&
      entry.message.toolName === "codemode" &&
      !entry.message.isError
        ? entry.message.details?.codemode?.storeWrites
        : undefined;
    if (writes !== undefined) {
      if (
        !writes ||
        !Array.isArray(writes.delete) ||
        !writes.set ||
        typeof writes.set !== "object" ||
        Array.isArray(writes.set)
      )
        throw new Error(`Invalid codemode store writes in ${file}: ${raw.id}`);
      childParent = synthetic(
        childParent,
        "custom",
        { customType: "codemode-store", data: writes },
        date,
      );
    }
    after.set(raw.id, childParent);
  }
  const tip = values.get("pi.branch.tip\0main");
  if ((!tip && entries.length) || (tip && tip.value !== null && !byId.has(tip.value)))
    throw new Error(`Missing or invalid main branch tip in ${file}`);
  const originalTipId = tip ? tip.value : null;
  let leaf: string | null = originalTipId === null ? null : after.get(originalTipId)!;
  const configWrite = values.get("pi.lane.config\0main");
  const config = configWrite?.value;
  if (
    configWrite &&
    (!config ||
      typeof config.model?.provider !== "string" ||
      typeof config.model?.modelId !== "string" ||
      typeof config.thinkingLevel !== "string" ||
      !Array.isArray(config.activeToolNames))
  )
    throw new Error(`Invalid main configuration in ${file}`);
  leaf = synthetic(leaf, "custom", {
    customType: "batty-agent-session-migration",
    data: {
      version: 1,
      sourceVersion: 4,
      originalTipId,
      configuration: config,
      branchTips: [...values.values()]
        .filter((write) => write.namespace === "pi.branch.tip")
        .map(({ key, value }) => ({ branch: key, tipId: value })),
    },
  });
  for (const write of values.values()) {
    if (
      executionNamespaces.has(write.namespace) ||
      ["pi.branch.tip", "pi.lane.config"].includes(write.namespace)
    )
      continue;
    if (write.namespace === "pi.session.name")
      leaf = synthetic(leaf, "session_info", { name: write.value });
    else if (write.namespace === "pi.entry.label")
      leaf = synthetic(leaf, "label", { targetId: write.key, label: write.value });
    else if (write.namespace === "pi.result")
      leaf = synthetic(leaf, "custom", {
        customType: "batty-agent-session-operation-result",
        data: await hydrate(write.value, file, images),
      });
    else if (write.namespace.startsWith("batty."))
      leaf = synthetic(leaf, "custom", {
        customType: write.namespace,
        data: { key: write.key, value: await hydrate(write.value, file, images) },
      });
    else throw new Error(`Unsupported stored namespace in ${file}: ${write.namespace}`);
  }
  for (const write of usage)
    leaf = synthetic(leaf, "custom", { customType: "batty-agent-session-usage", data: write });
  if (configWrite) {
    leaf = synthetic(leaf, "model_change", {
      provider: config.model.provider,
      modelId: config.model.modelId,
    });
    synthetic(leaf, "thinking_level_change", { thinkingLevel: config.thinkingLevel });
  }
  let parentSession: string | undefined;
  if (header.parentSessionId !== undefined) {
    if (typeof header.parentSessionId !== "string")
      throw new Error(`Invalid parent session ID in ${file}`);
    parentSession = pathsById.get(header.parentSessionId) ?? header.parentSessionId;
  } else if (header.legacyParentSessionPath !== undefined)
    parentSession = header.legacyParentSessionPath;
  const nativeHeader = {
    type: "session",
    version: 3,
    id: header.id,
    timestamp: createdAt,
    cwd: header.cwd,
    ...(parentSession === undefined ? {} : { parentSession }),
  };
  return {
    content: `${[nativeHeader, ...output].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    entries: entries.length,
    images: images.size,
    droppedExecutionWrites,
  };
}

/** Offline, one-time conversion. Validate every session before creating backups or replacing files. */
export async function migrateAgentSessions(
  root: string,
  options: { dryRun?: boolean } = {},
): Promise<AgentSessionMigrationSummary> {
  const directory = path.resolve(root, ".batty", "sessions");
  const summary: AgentSessionMigrationSummary = {
    scanned: 0,
    migratedFiles: 0,
    unchanged: 0,
    entries: 0,
    images: 0,
    droppedExecutionWrites: 0,
    originalBytes: 0,
    convertedBytes: 0,
    largestConvertedFileBytes: 0,
    dryRun: options.dryRun ?? false,
  };
  try {
    await fs.stat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return summary;
    throw error;
  }
  const files = await sessionFiles(directory);
  summary.scanned = files.length;
  const pathsById = new Map<string, string>();
  for (const file of files) {
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0]!;
      const header = record(JSON.parse(firstLine), "session header");
      if (typeof header.id !== "string") throw new Error(`Missing session identity in ${file}`);
      // Fork copies may retain a session identity in multiple workspace-owned paths.
      if (!pathsById.has(header.id)) pathsById.set(header.id, file);
    } finally {
      await handle.close();
    }
  }
  const validated: Array<{ file: string; hash: string }> = [];
  const validationErrors: Error[] = [];
  for (const file of files) {
    try {
      const original = await fs.readFile(file, "utf8");
      const converted = await prepare(file, original, pathsById);
      if (!converted) {
        summary.unchanged++;
        continue;
      }
      validated.push({ file, hash: createHash("sha256").update(original).digest("hex") });
      summary.migratedFiles++;
      const convertedBytes = Buffer.byteLength(converted.content);
      summary.originalBytes += Buffer.byteLength(original);
      summary.convertedBytes += convertedBytes;
      summary.largestConvertedFileBytes = Math.max(
        summary.largestConvertedFileBytes,
        convertedBytes,
      );
      summary.entries += converted.entries;
      summary.images += converted.images;
      summary.droppedExecutionWrites += converted.droppedExecutionWrites;
    } catch (error) {
      validationErrors.push(
        new Error(`Session validation failed for ${file}: ${(error as Error).message}`, {
          cause: error,
        }),
      );
    }
  }
  if (validationErrors.length)
    throw new AggregateError(
      validationErrors,
      `Session migration prevalidation failed for ${validationErrors.length} file(s):\n${validationErrors.map((error) => error.message).join("\n")}`,
    );
  if (summary.dryRun || !validated.length) return summary;
  // A changing source must not yield a partially converted dataset. Deployment stops the server first.
  for (const { file, hash } of validated) {
    if (
      createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex") !== hash
    )
      throw new Error(`Session changed during migration validation: ${file}`);
  }
  const backupPath = path.resolve(
    root,
    ".batty",
    "session-migration-backups",
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
  );
  const backupDirectories = new Set<string>();
  const battyDirectory = path.resolve(root, ".batty");
  for (const { file } of validated) {
    const backup = path.join(backupPath, path.relative(directory, file));
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.copyFile(file, backup);
    await syncFile(backup);
    for (let containing = path.dirname(backup); ; containing = path.dirname(containing)) {
      backupDirectories.add(containing);
      if (containing === battyDirectory) break;
    }
  }
  // Flush the entire backup tree, including the parents that publish its root,
  // before replacing any session. Children are flushed before their parents.
  for (const containing of [...backupDirectories].sort((a, b) => b.length - a.length))
    await syncDirectory(containing);
  summary.backupPath = backupPath;
  for (const { file } of validated) {
    const original = await fs.readFile(
      path.join(backupPath, path.relative(directory, file)),
      "utf8",
    );
    const converted = (await prepare(file, original, pathsById))!;
    const temporary = `${file}.migration-${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", (await fs.stat(file)).mode);
    try {
      await handle.writeFile(converted.content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  }
  return summary;
}
