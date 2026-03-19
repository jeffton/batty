import { describe, expect, it } from "vite-plus/test";
import { uniqueWorkspaces } from "@/client/lib/workspaces";
import type { WorkspaceInfo } from "@/shared/types";

describe("uniqueWorkspaces", () => {
  it("keeps the first workspace for duplicate paths", () => {
    const workspaces: WorkspaceInfo[] = [
      { id: "pi-face", label: "pi-face", path: "/root/github/pi-face", kind: "self" },
      { id: "babyface", label: "babyface", path: "/root/github/babyface", kind: "workspace" },
      {
        id: "babyface copy",
        label: "babyface duplicate path",
        path: "/root/github/babyface",
        kind: "workspace",
      },
    ];

    expect(uniqueWorkspaces(workspaces)).toEqual([
      { id: "pi-face", label: "pi-face", path: "/root/github/pi-face", kind: "self" },
      { id: "babyface", label: "babyface", path: "/root/github/babyface", kind: "workspace" },
    ]);
  });
});
