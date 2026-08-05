import { describe, expect, it } from "vite-plus/test";
import {
  matchingSessions,
  sessionsForWorkspaceSearch,
  workspaceSearchMatch,
} from "@/client/lib/workspace-browser-search";
import type { SessionSummary, WorkspaceInfo } from "@/shared/types";

function makeWorkspace(label: string): WorkspaceInfo {
  return {
    id: label,
    label,
    path: `/workspaces/${label}`,
    kind: "workspace",
    isPinned: false,
    isAssistant: false,
  };
}

function makeSession(workspaceId: string, sessionId: string, name: string): SessionSummary {
  return {
    id: sessionId,
    sessionId,
    name,
    firstMessage: "",
    updatedAt: 1,
    messageCount: 1,
    workspaceId,
  };
}

const sessionLabel = (session: SessionSummary): string => session.name ?? session.firstMessage;

describe("workspace browser search", () => {
  it("treats a workspace text match as a workspace match", () => {
    const workspace = makeWorkspace("alpha-project");
    const sessions = [makeSession(workspace.id, "one", "unrelated task")];

    expect(workspaceSearchMatch(workspace, sessions, "alpha", sessionLabel)).toBe("workspace");
    expect(sessionsForWorkspaceSearch(workspace, sessions, "alpha", sessionLabel)).toEqual(
      sessions,
    );
  });

  it("surfaces a workspace when one of its sessions matches", () => {
    const workspace = makeWorkspace("backend");
    const matching = makeSession(workspace.id, "one", "fix authentication");
    const unrelated = makeSession(workspace.id, "two", "deploy notes");

    expect(
      workspaceSearchMatch(workspace, [matching, unrelated], "authentication", sessionLabel),
    ).toBe("session");
    expect(matchingSessions([matching, unrelated], "authentication", sessionLabel)).toEqual([
      matching,
    ]);
    expect(
      sessionsForWorkspaceSearch(workspace, [matching, unrelated], "authentication", sessionLabel),
    ).toEqual([matching]);
  });

  it("gives a workspace match precedence over matching sessions", () => {
    const workspace = makeWorkspace("alpha");
    const sessions = [
      makeSession(workspace.id, "one", "alpha task"),
      makeSession(workspace.id, "two", "unrelated task"),
    ];

    expect(workspaceSearchMatch(workspace, sessions, "alpha", sessionLabel)).toBe("workspace");
  });

  it("does not match a workspace without a workspace or session match", () => {
    const workspace = makeWorkspace("backend");
    const sessions = [makeSession(workspace.id, "one", "deploy notes")];

    expect(
      workspaceSearchMatch(workspace, sessions, "authentication", sessionLabel),
    ).toBeUndefined();
  });
});
