import { describe, expect, it } from "vite-plus/test";
import { battyActivePiToolNames } from "@/shared/pi-tools";

describe("Pi shell tools", () => {
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
