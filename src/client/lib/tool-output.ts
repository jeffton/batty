export interface TailView {
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
