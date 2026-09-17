import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { err, FileError, ok, toError } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

const IMAGE_REFERENCE_PREFIX = "batty-file:";
const migrations = new Map<string, Promise<void>>();

type TransformDirection = "externalize" | "hydrate";

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

export class SessionImageExecutionEnv extends NodeExecutionEnv {
  private readonly images = new SessionImageStore();

  override async readTextFile(
    ...args: Parameters<NodeExecutionEnv["readTextFile"]>
  ): ReturnType<NodeExecutionEnv["readTextFile"]> {
    const [filePath] = args;
    const result = await super.readTextFile(...args);
    if (!result.ok) return result;
    try {
      return ok<string, FileError>(
        await this.images.transformText(result.value, "hydrate", filePath),
      );
    } catch (error) {
      return err(new FileError("unknown", toError(error).message, filePath, toError(error)));
    }
  }

  override async readTextLines(
    ...args: Parameters<NodeExecutionEnv["readTextLines"]>
  ): ReturnType<NodeExecutionEnv["readTextLines"]> {
    const [filePath] = args;
    const result = await super.readTextLines(...args);
    if (!result.ok) return result;
    try {
      return ok<string[], FileError>(
        await this.images.transformLines(result.value, "hydrate", filePath),
      );
    } catch (error) {
      return err(new FileError("unknown", toError(error).message, filePath, toError(error)));
    }
  }

  override async writeFile(
    ...args: Parameters<NodeExecutionEnv["writeFile"]>
  ): ReturnType<NodeExecutionEnv["writeFile"]> {
    const [filePath, content, context] = args;
    try {
      const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
      return super.writeFile(
        filePath,
        await this.images.transformText(text, "externalize", filePath),
        context,
      );
    } catch (error) {
      return err(new FileError("unknown", toError(error).message, filePath, toError(error)));
    }
  }

  override async appendFile(
    ...args: Parameters<NodeExecutionEnv["appendFile"]>
  ): ReturnType<NodeExecutionEnv["appendFile"]> {
    const [filePath, content, context] = args;
    try {
      const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
      return super.appendFile(
        filePath,
        await this.images.transformText(text, "externalize", filePath),
        context,
      );
    } catch (error) {
      return err(new FileError("unknown", toError(error).message, filePath, toError(error)));
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
