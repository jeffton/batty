import { describe, expect, it } from "vite-plus/test";
import {
  BATTY_SYSTEM_PROMPT_CUSTOM_TYPE,
  buildBattySystemPromptSnapshot,
  findBattySystemPromptSnapshot,
} from "./batty-system-prompt";

describe("batty system prompt", () => {
  it("builds a static Batty session prompt snapshot", () => {
    const snapshot = buildBattySystemPromptSnapshot(
      { id: "batty", path: "/root/github/batty" },
      "openai/gpt-5",
      "medium",
      new Date("2026-03-20T12:00:00Z"),
      "/root/github/batty/README.md",
    );

    expect(snapshot).toMatchObject({
      workspaceId: "batty",
      workspacePath: "/root/github/batty",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      date: "2026-03-20",
      isoWeek: 12,
    });
    expect(snapshot.dailySessionDate).toBeUndefined();
    expect(snapshot.appendedPrompt).toContain("you are running inside Batty");
    expect(snapshot.appendedPrompt).toContain("reply with exactly NO_REPLY");
    expect(snapshot.appendedPrompt).toContain("Batty README: /root/github/batty/README.md");
    expect(snapshot.appendedPrompt).toContain("Current workspace: batty (/root/github/batty)");
    expect(snapshot.appendedPrompt).toContain("Current model: openai/gpt-5");
    expect(snapshot.appendedPrompt).toContain("Current thinking level: medium");
    expect(snapshot.appendedPrompt).toContain("Current date: 2026-03-20 (Friday, ISO week 12)");
  });

  it("uses local time instead of UTC for date boundaries", () => {
    const snapshot = buildBattySystemPromptSnapshot(
      { id: "batty", path: "/root/github/batty" },
      "openai/gpt-5",
      "medium",
      new Date("2026-03-30T22:30:00Z"),
    );

    expect(snapshot.date).toBe("2026-03-31");
    expect(snapshot.isoWeek).toBe(14);
    expect(snapshot.appendedPrompt).toContain("Current date: 2026-03-31 (Tuesday, ISO week 14)");
  });

  it("mentions the workspace daily session when running in today's daily session", () => {
    const snapshot = buildBattySystemPromptSnapshot(
      { id: "batty", path: "/root/github/batty" },
      "openai/gpt-5",
      "medium",
      new Date("2026-03-20T12:00:00Z"),
      "/root/github/batty/README.md",
      "2026-03-20",
    );

    expect(snapshot.dailySessionDate).toBe("2026-03-20");
    expect(snapshot.appendedPrompt).toContain(
      "Current session: today's daily session for workspace batty",
    );
  });

  it("does not mention the workspace daily session when the bound daily session is not today", () => {
    const snapshot = buildBattySystemPromptSnapshot(
      { id: "batty", path: "/root/github/batty" },
      "openai/gpt-5",
      "medium",
      new Date("2026-03-20T12:00:00Z"),
      "/root/github/batty/README.md",
      "2026-03-19",
    );

    expect(snapshot.dailySessionDate).toBe("2026-03-19");
    expect(snapshot.appendedPrompt).not.toContain("Current session:");
  });

  it("finds the latest persisted Batty prompt snapshot", () => {
    const older = buildBattySystemPromptSnapshot(
      { id: "batty", path: "/root/github/batty" },
      "anthropic/claude-sonnet-4",
      "low",
      new Date("2026-03-19T12:00:00Z"),
    );
    const newer = buildBattySystemPromptSnapshot(
      { id: "batty", path: "/root/github/batty" },
      "openai/gpt-5",
      "high",
      new Date("2026-03-20T12:00:00Z"),
    );

    const snapshot = findBattySystemPromptSnapshot([
      { type: "custom", customType: BATTY_SYSTEM_PROMPT_CUSTOM_TYPE, data: older },
      { type: "custom", customType: "other", data: { nope: true } },
      { type: "custom", customType: BATTY_SYSTEM_PROMPT_CUSTOM_TYPE, data: newer },
    ]);

    expect(snapshot).toEqual(newer);
  });
});
