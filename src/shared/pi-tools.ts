export type PiShellToolName = "bash" | "powershell";
export type ToolOutputTruncationDirection = "head" | "tail";

export const TOOL_OUTPUT_TRUNCATION_DIRECTIONS = {
  bash: "tail",
  powershell: "tail",
  write: "tail",
  read: "head",
  cron: "head",
  "web-search": "head",
  grep: "head",
  find: "head",
} as const satisfies Record<string, ToolOutputTruncationDirection>;

export type TruncatedToolName = keyof typeof TOOL_OUTPUT_TRUNCATION_DIRECTIONS;

export function isPiShellToolName(name: string): name is PiShellToolName {
  return name === "bash" || name === "powershell";
}

export function piShellToolNameForPlatform(platform: string): PiShellToolName {
  return platform === "win32" ? "powershell" : "bash";
}

export function battyPiToolNamesForPlatform(platform: string): string[] {
  return ["read", piShellToolNameForPlatform(platform), "edit", "write", "grep", "find"];
}

export function battyActivePiToolNames(
  activeToolNames: Iterable<string>,
  platform: string,
): string[] {
  return [
    ...new Set([
      ...Array.from(activeToolNames).filter((name) => !isPiShellToolName(name)),
      ...battyPiToolNamesForPlatform(platform),
    ]),
  ];
}
