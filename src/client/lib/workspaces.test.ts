import { describe, expect, it } from "vite-plus/test";
import { sortWorkspacesByRecentSession, uniqueWorkspaces } from "@/client/lib/workspaces";
import type { WorkspaceInfo } from "@/shared/types";

describe("uniqueWorkspaces", () => {
  it("keeps the first workspace for duplicate paths", () => {
    const workspaces: WorkspaceInfo[] = [
      {
        id: "batty",
        label: "batty",
        path: "/root/github/batty",
        kind: "workspace",
        isPinned: false,
      },
      {
        id: "babyface",
        label: "babyface",
        path: "/root/github/babyface",
        kind: "workspace",
        isPinned: false,
      },
      {
        id: "babyface copy",
        label: "babyface duplicate path",
        path: "/root/github/babyface",
        kind: "workspace",
        isPinned: false,
      },
    ];

    expect(uniqueWorkspaces(workspaces)).toEqual([
      {
        id: "batty",
        label: "batty",
        path: "/root/github/batty",
        kind: "workspace",
        isPinned: false,
      },
      {
        id: "babyface",
        label: "babyface",
        path: "/root/github/babyface",
        kind: "workspace",
        isPinned: false,
      },
    ]);
  });
});

describe("sortWorkspacesByRecentSession", () => {
  it("orders workspaces alphabetically when nothing is pinned", () => {
    const workspaces: WorkspaceInfo[] = [
      { id: "zeta", label: "zeta", path: "/root/github/zeta", kind: "workspace", isPinned: false },
      {
        id: "alpha",
        label: "alpha",
        path: "/root/github/alpha",
        kind: "workspace",
        isPinned: false,
      },
      { id: "beta", label: "beta", path: "/root/github/beta", kind: "workspace", isPinned: false },
    ];

    expect(sortWorkspacesByRecentSession(workspaces).map(({ id }) => id)).toEqual([
      "alpha",
      "beta",
      "zeta",
    ]);
  });

  it("keeps pinned workspaces on top and sorts each group alphabetically", () => {
    const workspaces: WorkspaceInfo[] = [
      { id: "zeta", label: "zeta", path: "/root/github/zeta", kind: "workspace", isPinned: true },
      {
        id: "alpha",
        label: "alpha",
        path: "/root/github/alpha",
        kind: "workspace",
        isPinned: false,
      },
      { id: "beta", label: "beta", path: "/root/github/beta", kind: "workspace", isPinned: true },
      {
        id: "delta",
        label: "delta",
        path: "/root/github/delta",
        kind: "workspace",
        isPinned: false,
      },
    ];

    expect(sortWorkspacesByRecentSession(workspaces).map(({ id }) => id)).toEqual([
      "beta",
      "zeta",
      "alpha",
      "delta",
    ]);
  });
});
