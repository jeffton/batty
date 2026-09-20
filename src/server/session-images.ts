import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { err, FileError, ok, toError, type FileSystem } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

const IMAGE_REFERENCE_PREFIX = "batty-file:";
const migrations = new Map<string, Promise<void>>();

type TransformDirection = "externalize" | "hydrate";
type TextLineReader = Extract<
  Awaited<ReturnType<FileSystem["openTextLineReader"]>>,
  { ok: true }
>["value"];

class SessionImageStore {
  async transformText(
    text: string,
    direction: TransformDirection,
    sessionFile: string,
  ): Promise<string> {
    const trailingNewline = text.endsWith("\n");
    const lines = text.split("\n");
    if (trailingNewline) lines.pop();
    const transformed = await Promise.all(
      lines.map((line) => this.transformLine(line, direction, sessionFile)),
    );
    return `${transformed.join("\n")}${trailingNewline ? "\n" : ""}`;
  }

  async transformLines(
    lines: string[],
    direction: TransformDirection,
    sessionFile: string,
  ): Promise<string[]> {
    return Promise.all(lines.map((line) => this.transformLine(line, direction, sessionFile)));
  }

  private async transformLine(
    line: string,
    direction: TransformDirection,
    sessionFile: string,
  ): Promise<string> {
    if (line.trim().length === 0) return line;
    try {
      return JSON.stringify(await this.transformValue(JSON.parse(line), direction, sessionFile));
    } catch (error) {
      if (error instanceof SyntaxError) return line;
      throw error;
    }
  }

  private async transformValue(
    value: unknown,
    direction: TransformDirection,
    sessionFile: string,
  ): Promise<unknown> {
    if (Array.isArray(value)) {
      return Promise.all(value.map((entry) => this.transformValue(entry, direction, sessionFile)));
    }
    if (!value || typeof value !== "object") return value;

    const record = value as Record<string, unknown>;
    if (
      record.type === "image" &&
      typeof record.mimeType === "string" &&
      typeof record.data === "string"
    ) {
      return {
        ...record,
        data:
          direction === "externalize"
            ? await this.externalize(record.data, record.mimeType, sessionFile)
            : await this.hydrate(record.data, sessionFile),
      };
    }

    const entries = await Promise.all(
      Object.entries(record).map(
        async ([key, entry]) =>
          [key, await this.transformValue(entry, direction, sessionFile)] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  private async externalize(data: string, mimeType: string, sessionFile: string): Promise<string> {
    if (data.startsWith(IMAGE_REFERENCE_PREFIX)) return data;
    const bytes = Buffer.from(data, "base64");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const extension = mimeType.split("/")[1]?.replace(/[^a-zA-Z0-9]+/g, "-") || "bin";
    const name = `${hash}.${extension}`;
    const assetsDir = path.join(path.dirname(sessionFile), ".batty-images");
    const destination = path.join(assetsDir, name);
    const temporary = path.join(assetsDir, `.${name}.${randomUUID()}.tmp`);
    await fs.mkdir(assetsDir, { recursive: true });
    try {
      const temporaryHandle = await fs.open(temporary, "wx");
      try {
        await temporaryHandle.writeFile(bytes);
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close();
      }
      try {
        await fs.rename(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await fs.readFile(destination);
        if (createHash("sha256").update(existing).digest("hex") !== hash) {
          await fs.rm(destination);
          await fs.rename(temporary, destination);
        }
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return `${IMAGE_REFERENCE_PREFIX}${name}`;
  }

  private async hydrate(data: string, sessionFile: string): Promise<string> {
    if (!data.startsWith(IMAGE_REFERENCE_PREFIX)) return data;
    const name = data.slice(IMAGE_REFERENCE_PREFIX.length);
    if (path.basename(name) !== name) throw new Error(`Invalid session image reference: ${data}`);
    return (
      await fs.readFile(path.join(path.dirname(sessionFile), ".batty-images", name))
    ).toString("base64");
  }
}

function isSessionStoragePath(filePath: string): boolean {
  return /\.jsonl(?:\.|$)/.test(path.basename(filePath));
}

function imageError(error: unknown, filePath: string): FileError {
  const cause = toError(error);
  return new FileError("unknown", cause.message, filePath, cause);
}

/** A Pi filesystem adapter that externalizes image payloads at the session-storage boundary. */
export class SessionImageFileSystem implements FileSystem {
  readonly cwd: string;
  protected readonly fileSystem: FileSystem;
  private readonly images = new SessionImageStore();

  constructor(options: { cwd: string; fileSystem?: FileSystem }) {
    this.fileSystem = options.fileSystem ?? new NodeExecutionEnv({ cwd: options.cwd });
    this.cwd = this.fileSystem.cwd;
  }

  absolutePath(...args: Parameters<FileSystem["absolutePath"]>) {
    return this.fileSystem.absolutePath(...args);
  }
  joinPath(...args: Parameters<FileSystem["joinPath"]>) {
    return this.fileSystem.joinPath(...args);
  }
  readBinaryFile(...args: Parameters<FileSystem["readBinaryFile"]>) {
    return this.fileSystem.readBinaryFile(...args);
  }
  renameFile(...args: Parameters<FileSystem["renameFile"]>) {
    return this.fileSystem.renameFile(...args);
  }
  fileInfo(...args: Parameters<FileSystem["fileInfo"]>) {
    return this.fileSystem.fileInfo(...args);
  }
  listDir(...args: Parameters<FileSystem["listDir"]>) {
    return this.fileSystem.listDir(...args);
  }
  canonicalPath(...args: Parameters<FileSystem["canonicalPath"]>) {
    return this.fileSystem.canonicalPath(...args);
  }
  exists(...args: Parameters<FileSystem["exists"]>) {
    return this.fileSystem.exists(...args);
  }
  createDir(...args: Parameters<FileSystem["createDir"]>) {
    return this.fileSystem.createDir(...args);
  }
  remove(...args: Parameters<FileSystem["remove"]>) {
    return this.fileSystem.remove(...args);
  }
  createTempDir(...args: Parameters<FileSystem["createTempDir"]>) {
    return this.fileSystem.createTempDir(...args);
  }
  createTempFile(...args: Parameters<FileSystem["createTempFile"]>) {
    return this.fileSystem.createTempFile(...args);
  }
  cleanup(...args: Parameters<FileSystem["cleanup"]>) {
    return this.fileSystem.cleanup(...args);
  }

  async readTextFile(
    ...args: Parameters<FileSystem["readTextFile"]>
  ): ReturnType<FileSystem["readTextFile"]> {
    const [filePath] = args;
    const result = await this.fileSystem.readTextFile(...args);
    if (!result.ok || !isSessionStoragePath(filePath)) return result;
    try {
      return ok<string, FileError>(
        await this.images.transformText(result.value, "hydrate", filePath),
      );
    } catch (error) {
      return err(imageError(error, filePath));
    }
  }

  async readTextLines(
    ...args: Parameters<FileSystem["readTextLines"]>
  ): ReturnType<FileSystem["readTextLines"]> {
    const [filePath] = args;
    const result = await this.fileSystem.readTextLines(...args);
    if (!result.ok || !isSessionStoragePath(filePath)) return result;
    try {
      return ok<string[], FileError>(
        await this.images.transformLines(result.value, "hydrate", filePath),
      );
    } catch (error) {
      return err(imageError(error, filePath));
    }
  }

  async openTextLineReader(
    ...args: Parameters<FileSystem["openTextLineReader"]>
  ): ReturnType<FileSystem["openTextLineReader"]> {
    const [filePath] = args;
    const result = await this.fileSystem.openTextLineReader(...args);
    if (!result.ok || !isSessionStoragePath(filePath)) return result;
    const reader = result.value;
    const images = this.images;
    const transformedReader: TextLineReader = {
      async readLine(context) {
        const line = await reader.readLine(context);
        if (!line.ok || line.value === undefined) return line;
        try {
          const [text] = await images.transformLines([line.value.text], "hydrate", filePath);
          return ok({ ...line.value, text: text! });
        } catch (error) {
          return err(imageError(error, filePath));
        }
      },
      close: (context) => reader.close(context),
    };
    return ok<TextLineReader, FileError>(transformedReader);
  }

  async writeFile(
    ...args: Parameters<FileSystem["writeFile"]>
  ): ReturnType<FileSystem["writeFile"]> {
    const [filePath, content, context] = args;
    if (!isSessionStoragePath(filePath)) return this.fileSystem.writeFile(...args);
    try {
      const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
      return this.fileSystem.writeFile(
        filePath,
        await this.images.transformText(text, "externalize", filePath),
        context,
      );
    } catch (error) {
      return err(imageError(error, filePath));
    }
  }

  async appendFile(
    ...args: Parameters<FileSystem["appendFile"]>
  ): ReturnType<FileSystem["appendFile"]> {
    const [filePath, content, context] = args;
    if (!isSessionStoragePath(filePath)) return this.fileSystem.appendFile(...args);
    try {
      const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
      return this.fileSystem.appendFile(
        filePath,
        await this.images.transformText(text, "externalize", filePath),
        context,
      );
    } catch (error) {
      return err(imageError(error, filePath));
    }
  }
}

export async function migrateSessionImages(file: string): Promise<void> {
  file = path.resolve(file);
  const existing = migrations.get(file);
  if (existing) return existing;
  const migrating = (async () => {
    for (;;) {
      const original = await fs.readFile(file, "utf8");
      try {
        for (const line of original.split("\n")) {
          if (line.trim().length > 0) JSON.parse(line);
        }
      } catch (error) {
        if (error instanceof SyntaxError) return;
        throw error;
      }
      const transformed = await new SessionImageStore().transformText(
        original,
        "externalize",
        file,
      );
      if (transformed === original) return;
      const temporary = `${file}.images-${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, transformed, "utf8");
        if ((await fs.readFile(file, "utf8")) !== original) continue;
        await fs.rename(temporary, file);
        return;
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
  })();
  migrations.set(file, migrating);
  try {
    await migrating;
  } finally {
    migrations.delete(file);
  }
}
