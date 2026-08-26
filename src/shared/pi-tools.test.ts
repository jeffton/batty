import { describe, expect, it } from "vite-plus/test";
import {
  battyActivePiToolNames,
  battyPiToolNamesForPlatform,
  isPiShellToolName,
  piShellToolNameForPlatform,
} from "@/shared/pi-tools";

describe("Pi shell tools", () => {
  it("selects PowerShell on Windows", () => {
    expect(piShellToolNameForPlatform("win32")).toBe("powershell");
    expect(battyPiToolNamesForPlatform("win32")).toEqual([
      "read",
      "powershell",
      "edit",
      "write",
      "grep",
      "find",
    ]);
  });

  it.each(["linux", "darwin"])("selects Bash on %s", (platform) => {
    expect(piShellToolNameForPlatform(platform)).toBe("bash");
  });

  it("recognizes both Pi shell tools", () => {
    expect(isPiShellToolName("bash")).toBe(true);
    expect(isPiShellToolName("powershell")).toBe(true);
    expect(isPiShellToolName("read")).toBe(false);
  });

  it("retains custom tools and activates only the Windows shell", () => {
    expect(battyActivePiToolNames(["subagent", "bash", "powershell"], "win32")).toEqual([
      "subagent",
      "read",
      "powershell",
      "edit",
      "write",
      "grep",
      "find",
    ]);
  });

  it("retains custom tools and activates only the Unix shell", () => {
    expect(battyActivePiToolNames(["subagent", "bash", "powershell"], "linux")).toEqual([
      "subagent",
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
    ]);
  });
});
