import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Git resolves nested directories, symlinks and linked worktrees itself. */
export async function workspaceGitBranch(workspacePath: string): Promise<string | null> {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", workspacePath, "symbolic-ref", "--quiet", "--short", "HEAD"],
      {
        windowsHide: true,
        env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    return stdout.trim();
  } catch (cause) {
    const error = cause as Error & { code?: number | string; stderr?: string };
    if (error.code === 1) return "detached HEAD";
    if (error.code === 128 && error.stderr?.startsWith("fatal: not a git repository (or any "))
      return null;
    throw cause;
  }
}
