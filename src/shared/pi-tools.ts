export type PiShellToolName = "bash" | "powershell";

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
