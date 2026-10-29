import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function chromeCandidates(
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
): string[] {
  switch (platform) {
    case "linux":
      return ["/opt/google/chrome/chrome"];
    case "darwin":
      return ["/Applications", path.join(home, "Applications")].map((root) =>
        path.join(root, "Google Chrome.app/Contents/MacOS/Google Chrome"),
      );
    case "win32":
      return [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
        .filter((root): root is string => !!root)
        .map((root) => path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"));
    default:
      throw new Error(`Chrome is not supported on ${platform}`);
  }
}

/** Production uses installed Google Chrome Stable, never the test browser bundle. */
export function browserExecutablePath(): string {
  const configured = process.env.BATTY_BROWSER_EXECUTABLE_PATH;
  if (configured !== undefined) {
    if (!path.isAbsolute(configured))
      throw new Error("BATTY_BROWSER_EXECUTABLE_PATH must be an absolute executable path");
    fs.accessSync(configured, fs.constants.X_OK);
    return configured;
  }
  const executable = chromeCandidates().find((candidate) => fs.existsSync(candidate));
  if (!executable)
    throw new Error(
      "Google Chrome Stable is not installed. Run scripts/setup-chrome.sh or scripts/setup-chrome.ps1.",
    );
  fs.accessSync(executable, fs.constants.X_OK);
  return executable;
}

/** Root-run tool browsers use the system package; pinned Chromium is test-only. */
export function isolatedBrowserExecutablePath(executable: string): string {
  if (executable === "/opt/google/chrome/chrome") return executable;
  if (process.env.BATTY_BROWSER_EXECUTABLE_PATH !== undefined)
    throw new Error("Root-isolated Chrome must use /opt/google/chrome/chrome");
  return path.join(
    "/opt/batty-browser",
    path.basename(path.dirname(path.dirname(executable))),
    path.basename(path.dirname(executable)),
    path.basename(executable),
  );
}
