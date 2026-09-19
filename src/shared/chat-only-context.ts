import { NO_REPLY_SENTINEL } from "./agent-notification";

export interface TranscriptContentBlockLike {
  type: string;
}

export function isTranscriptDetailsMessageRole(role: string): boolean {
  return role === "custom" || role === "toolResult" || role === "bashExecution";
}

export function isTranscriptDetailsBlock(block: TranscriptContentBlockLike): boolean {
  return block.type === "toolCall" || block.type === "thinking";
}

function blockText(block: TranscriptContentBlockLike): string {
  if (block.type !== "text") return "";
  return String((block as TranscriptContentBlockLike & { text?: unknown }).text ?? "");
}

export function chatOnlyBlocks<T extends TranscriptContentBlockLike>(
  role: string,
  blocks: T[],
  keepDetailsBlock?: (block: T) => boolean,
): T[] | undefined {
  if (isTranscriptDetailsMessageRole(role) || (role !== "user" && role !== "assistant")) {
    return undefined;
  }

  if (role === "user") return blocks;

  const visible = blocks.filter(
    (block) => !isTranscriptDetailsBlock(block) || keepDetailsBlock?.(block) === true,
  );
  const text = visible.map(blockText).join("").trim();
  if (text === NO_REPLY_SENTINEL || visible.length === 0) return undefined;
  return visible;
}
