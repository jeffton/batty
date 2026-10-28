import path from "node:path";

/** One browser choice for persistent tool sessions and shared headless work. */
export function browserExecutablePath(bundledExecutable: () => string): string {
  const configured = process.env.BATTY_BROWSER_EXECUTABLE_PATH;
  if (configured === undefined) return bundledExecutable();
  if (!path.isAbsolute(configured))
    throw new Error("BATTY_BROWSER_EXECUTABLE_PATH must be an absolute executable path");
  return configured;
}

/** Explicit installations already live at their final, root-controlled location. */
export function isolatedBrowserExecutablePath(executable: string): string {
  if (process.env.BATTY_BROWSER_EXECUTABLE_PATH !== undefined) {
    if (!/^\/opt\/batty-browser\/chromium-[^/]+\/chrome-linux[^/]*\/chrome$/.test(executable))
      throw new Error(
        "Explicit isolated Chromium must be installed under /opt/batty-browser/chromium-*/chrome-linux*/chrome",
      );
    return executable;
  }
  return path.join(
    "/opt/batty-browser",
    path.basename(path.dirname(path.dirname(executable))),
    path.basename(path.dirname(executable)),
    path.basename(executable),
  );
}
