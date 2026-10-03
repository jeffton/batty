import {
  TOOL_OUTPUT_TRUNCATION_DIRECTIONS,
  type ToolOutputTruncationDirection,
  type TruncatedToolName,
} from "@/shared/pi-tools";

export interface ToolOutputView {
  text: string;
  hiddenLineCount: number;
  totalLineCount: number;
  isTrimmed: boolean;
}

function createOutputView(
  text: string,
  windowSize: number,
  direction: ToolOutputTruncationDirection,
): ToolOutputView {
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const isTrimmed = lines.length > windowSize;

  return {
    text: isTrimmed
      ? (direction === "head" ? lines.slice(0, windowSize) : lines.slice(-windowSize)).join("\n")
      : text,
    hiddenLineCount: Math.max(0, lines.length - windowSize),
    totalLineCount: lines.length,
    isTrimmed,
  };
}

export function createHeadView(text: string, windowSize = 25): ToolOutputView {
  return createOutputView(text, windowSize, "head");
}

export function createToolOutputView(
  toolName: TruncatedToolName,
  text: string,
  windowSize = 25,
): ToolOutputView {
  return createOutputView(text, windowSize, TOOL_OUTPUT_TRUNCATION_DIRECTIONS[toolName]);
}
