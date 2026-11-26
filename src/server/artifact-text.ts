import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import type { FastifyReply } from "fastify";
import { isTextArtifactCandidate } from "@/shared/artifact-library";
import type { SentFileDescriptor } from "@/shared/types";
import { missingFile } from "./artifact-storage";
import { INLINE_TEXT_MAX_BYTES } from "./text-output-limits";

function utf8(bytes: Uint8Array, stream = false) {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
}

export async function hasTextPreview(file: SentFileDescriptor, filename: string) {
  if (!isTextArtifactCandidate(file)) return false;
  try {
    const handle = await fs.open(filename, "r");
    try {
      // Type sniffing only; the full preview is validated when requested.
      const sample = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
      return utf8(sample.subarray(0, bytesRead), bytesRead === sample.length) !== undefined;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (missingFile(error)) return false;
    throw error;
  }
}

export async function sendArtifactText(
  reply: FastifyReply,
  file: Pick<SentFileDescriptor, "name" | "mimeType">,
  filename: string,
) {
  if (isTextArtifactCandidate(file)) {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of createReadStream(filename, {
        start: 0,
        end: INLINE_TEXT_MAX_BYTES,
      }))
        chunks.push(chunk as Buffer);
      const bytes = Buffer.concat(chunks);
      const truncated = bytes.length > INLINE_TEXT_MAX_BYTES;
      const contents = utf8(bytes.subarray(0, INLINE_TEXT_MAX_BYTES), truncated);
      if (contents !== undefined) {
        if (truncated) reply.header("X-Batty-Preview-Truncated", "1");
        return reply
          .header("X-Content-Type-Options", "nosniff")
          .type("text/plain; charset=utf-8")
          .send(contents);
      }
    } catch (error) {
      if (!missingFile(error)) throw error;
      return reply.code(404).send({ error: "File not found" });
    }
  }
  return reply.code(415).send({ error: "File has no UTF-8 text preview" });
}
