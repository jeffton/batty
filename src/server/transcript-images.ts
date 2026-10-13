import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { appBasePath } from "./app-shell";
import type { SessionState, UiContentBlock, UiMessage } from "@/shared/types";

const pending = new Map<string, Promise<void>>();

export async function imagePreview(filePath: string): Promise<Buffer> {
  const previewPath = `${filePath}.preview.webp`;
  try {
    return await fs.readFile(previewPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const data = await sharp(filePath, { limitInputPixels: 64_000_000 })
    .rotate()
    .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer();
  await fs.writeFile(previewPath, data);
  return data;
}

export class TranscriptImages {
  private readonly basePath: string;

  constructor(
    private readonly directory: string,
    baseUrl = "/",
  ) {
    this.basePath = appBasePath(baseUrl);
  }

  async resolve(id: string, preview: boolean) {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw Object.assign(new Error("Invalid image ID"), { statusCode: 400 });
    const mimeType = await fs.readFile(path.join(this.directory, `${id}.mime`), "utf8");
    const originalPath = path.join(this.directory, `${id}.original`);
    if (preview) await imagePreview(originalPath);
    return {
      path: preview ? `${originalPath}.preview.webp` : originalPath,
      mimeType: preview ? "image/webp" : mimeType,
    };
  }

  private async block(block: UiContentBlock): Promise<UiContentBlock> {
    if (block.type !== "image") return block;
    if (block.url) {
      return block.url.startsWith(`${this.basePath}api/uploads/`) ||
        block.url.startsWith(`${this.basePath}api/sent-files/`)
        ? { ...block, previewUrl: `${block.url}${block.url.includes("?") ? "&" : "?"}preview=1` }
        : block;
    }
    if (!block.data) return block;
    const id = createHash("sha256").update(block.mimeType).update(block.data).digest("hex");
    const filePath = path.join(this.directory, `${id}.original`);
    let work = pending.get(id);
    if (!work) {
      work = (async () => {
        await fs.mkdir(this.directory, { recursive: true });
        try {
          await fs.access(filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await fs.writeFile(filePath, Buffer.from(block.data!, "base64"));
          await fs.writeFile(path.join(this.directory, `${id}.mime`), block.mimeType);
        }
      })();
      pending.set(id, work);
      void work.finally(() => pending.delete(id)).catch(() => {});
    }
    await work;
    const { data: _data, ...metadata } = block;
    return {
      ...metadata,
      url: `${this.basePath}api/transcript-images/${id}`,
      previewUrl: `${this.basePath}api/transcript-images/${id}?preview=1`,
    };
  }

  async messages(messages: UiMessage[]): Promise<UiMessage[]> {
    const result: UiMessage[] = [];
    // Serial processing bounds concurrent image decoders during history pagination.
    for (const message of messages) {
      result.push(
        "blocks" in message
          ? {
              ...message,
              blocks: await Promise.all(message.blocks.map((block) => this.block(block))),
            }
          : message,
      );
    }
    return result;
  }

  async state(state: SessionState): Promise<SessionState> {
    return {
      ...state,
      messages: await this.messages(state.messages),
      activeTools: await Promise.all(
        state.activeTools.map(async (tool) => ({
          ...tool,
          blocks: await Promise.all(tool.blocks.map((block) => this.block(block))),
        })),
      ),
      activeAssistant: state.activeAssistant
        ? ((await this.messages([state.activeAssistant]))[0] as SessionState["activeAssistant"])
        : undefined,
    };
  }
}
