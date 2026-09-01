import { TOOL_OUTPUT_TRUNCATION_DIRECTIONS, type TruncatedToolName } from "@/shared/pi-tools";

export interface TailView {
  text: string;
  hiddenLineCount: number;
  totalLineCount: number;
  isTrimmed: boolean;
}

export interface HeadView {
  text: string;
  hiddenLineCount: number;
  totalLineCount: number;
  isTrimmed: boolean;
}

function splitLines(text: string): string[] {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

export function createTailView(text: string, windowSize = 25): TailView {
  const lines = splitLines(text);

  if (lines.length <= windowSize) {
    return {
      text,
      hiddenLineCount: 0,
      totalLineCount: lines.length,
      isTrimmed: false,
    };
  }

  return {
    text: lines.slice(-windowSize).join("\n"),
    hiddenLineCount: lines.length - windowSize,
    totalLineCount: lines.length,
    isTrimmed: true,
  };
}

export function createHeadView(text: string, windowSize = 25): HeadView {
  const lines = splitLines(text);

  if (lines.length <= windowSize) {
    return {
      text,
      hiddenLineCount: 0,
      totalLineCount: lines.length,
      isTrimmed: false,
    };
  }

  return {
    text: lines.slice(0, windowSize).join("\n"),
    hiddenLineCount: lines.length - windowSize,
    totalLineCount: lines.length,
    isTrimmed: true,
  };
}

export function createToolOutputView(
  toolName: TruncatedToolName,
  text: string,
  windowSize = 25,
): HeadView | TailView {
  return TOOL_OUTPUT_TRUNCATION_DIRECTIONS[toolName] === "head"
    ? createHeadView(text, windowSize)
    : createTailView(text, windowSize);
}
