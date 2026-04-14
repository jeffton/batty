import { describe, expect, it } from "vite-plus/test";
import { formatDailySessionTitle, sessionDisplayTitle } from "@/client/lib/daily-sessions";
import type { SessionSummary } from "@/shared/types";

describe("daily session titles", () => {
  const now = new Date(2026, 3, 14, 12, 0, 0);

  it("formats recent daily sessions by day label", () => {
    expect(formatDailySessionTitle("2026-04-14", now)).toBe("Today");
    expect(formatDailySessionTitle("2026-04-13", now)).toBe("Yesterday");
    expect(formatDailySessionTitle("2026-04-12", now)).toBe("Sunday");
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

    expect(sessionDisplayTitle(session, new Date(2026, 3, 13, 23, 0, 0))).toBe("Today");
  });
});
