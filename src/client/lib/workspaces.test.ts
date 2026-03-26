import { describe, expect, it } from "vite-plus/test";
import { sortWorkspacesByRecentSession, uniqueWorkspaces } from "@/client/lib/workspaces";
import type { SessionSummary, WorkspaceInfo } from "@/shared/types";

describe("uniqueWorkspaces", () => {
  it("keeps the first workspace for duplicate paths", () => {
    const workspaces: WorkspaceInfo[] = [
      { id: "batty", label: "batty", path: "/root/github/batty", kind: "workspace" },
      { id: "babyface", label: "babyface", path: "/root/github/babyface", kind: "workspace" },
      {
        id: "babyface copy",
        label: "babyface duplicate path",
        path: "/root/github/babyface",
        kind: "workspace",
      },
    ];

    expect(uniqueWorkspaces(workspaces)).toEqual([
      { id: "batty", label: "batty", path: "/root/github/batty", kind: "workspace" },
      { id: "babyface", label: "babyface", path: "/root/github/babyface", kind: "workspace" },
    ]);
  });
});

describe("sortWorkspacesByRecentSession", () => {
  it("orders workspaces by newest session and falls back to alphabetical order", () => {
    const workspaces: WorkspaceInfo[] = [
      { id: "zeta", label: "zeta", path: "/root/github/zeta", kind: "workspace" },
      { id: "alpha", label: "alpha", path: "/root/github/alpha", kind: "workspace" },
      { id: "beta", label: "beta", path: "/root/github/beta", kind: "workspace" },
    ];
    const sessionsByWorkspace: Record<string, SessionSummary[]> = {
      beta: [
        {
          id: "beta-session",
          sessionId: "beta-session",
          path: "/root/github/beta/.pi/sessions/beta.jsonl",
          firstMessage: "beta",
          updatedAt: 200,
          messageCount: 1,
          workspaceId: "beta",
        },
      ],
      zeta: [
        {
          id: "zeta-session",
          sessionId: "zeta-session",
          path: "/root/github/zeta/.pi/sessions/zeta.jsonl",
          firstMessage: "zeta",
          updatedAt: 100,
          messageCount: 1,
          workspaceId: "zeta",
        },
      ],
    };

    expect(
      sortWorkspacesByRecentSession(workspaces, sessionsByWorkspace).map(({ id }) => id),
    ).toEqual(["beta", "zeta", "alpha"]);
  });
});
