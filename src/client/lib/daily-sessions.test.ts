import { describe, expect, it } from "vite-plus/test";
import { formatDailySessionTitle, sessionDisplayTitle } from "@/client/lib/daily-sessions";
import type { SessionSummary } from "@/shared/types";

describe("daily session titles", () => {
  const now = new Date(2026, 3, 14, 12, 0, 0);

  it("formats recent daily sessions with distinct relative labels", () => {
    const labels = ["2026-04-14", "2026-04-13", "2026-04-12"].map((date) =>
      formatDailySessionTitle(date, now),
    );

    expect(new Set(labels).size).toBe(3);
    expect(labels.every((label) => label.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(label))).toBe(
      true,
    );
  });

  it("formats older daily sessions as iso dates", () => {
    expect(formatDailySessionTitle("2026-04-07", now)).toBe("2026-04-07");
  });

  it("prefers the server-provided today marker", () => {
    const session: SessionSummary = {
      id: "daily:batty:2026-04-14",
      sessionId: "daily:batty:2026-04-14",
      firstMessage: "(no messages)",
      updatedAt: 0,
      messageCount: 0,
      workspaceId: "batty",
      dailySession: {
        date: "2026-04-14",
        isToday: true,
        exists: false,
      },
    };

    const today = new Date(2026, 4, 1, 12, 0, 0);
    const todayLabel = formatDailySessionTitle("2026-05-01", today);

    expect(sessionDisplayTitle(session, today)).toBe(todayLabel);
  });
});
