import type { SessionSummary } from "@/shared/types";

function parseLocalIsoDate(date: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    return undefined;
  }

  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  return new Date(year, month - 1, day);
}

function formatLocalIsoDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function dayDifference(date: string, now: Date): number | undefined {
  const target = parseLocalIsoDate(date);
  if (!target) {
    return undefined;
  }

  const today = parseLocalIsoDate(formatLocalIsoDate(now));
  if (!today) {
    return undefined;
  }

  return Math.round((today.getTime() - target.getTime()) / (24 * 60 * 60 * 1000));
}

export function formatDailySessionTitle(date: string, now = new Date()): string {
  const diff = dayDifference(date, now);
  if (diff == null) {
    return date;
  }

  if (diff <= 0) {
    return "Today";
  }

  if (diff === 1) {
    return "Yesterday";
  }

  if (diff < 7) {
    const target = parseLocalIsoDate(date);
    if (!target) {
      return date;
    }

    return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(target);
  }

  return date;
}

export function sessionDisplayTitle(session: SessionSummary, now = new Date()): string {
  if (!session.dailySession) {
    return (session.firstMessage || "(no messages)").replace(/\s+/g, " ").trim();
  }

  if (session.dailySession.isToday) {
    return "Today";
  }

  return formatDailySessionTitle(session.dailySession.date, now);
}
