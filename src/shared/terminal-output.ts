import type { UiContentBlock } from "@/shared/types";

const ANSI_ESCAPE_PATTERN = new RegExp(
  String.raw`[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))`,
  "g",
);
const ORPHANED_CSI_PATTERN = /\[(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

export function stripTerminalFormatting(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "").replace(ORPHANED_CSI_PATTERN, "");
}

export function sanitizeTerminalBlocks(blocks: UiContentBlock[]): UiContentBlock[] {
  return blocks.map((block) => {
    if (block.type === "text") {
      return { ...block, text: stripTerminalFormatting(block.text) };
    }

    if (block.type === "thinking") {
      return { ...block, thinking: stripTerminalFormatting(block.thinking) };
    }

    return block;
  });
}
