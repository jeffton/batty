const clientLocales = navigator.languages.length > 0 ? navigator.languages : [navigator.language];

const timeFormatter = new Intl.DateTimeFormat(clientLocales, {
  hour: "2-digit",
  minute: "2-digit",
});

const dateTimeFormatter = new Intl.DateTimeFormat(clientLocales, {
  dateStyle: "short",
  timeStyle: "short",
});

function isValidTimestamp(timestamp: number): boolean {
  return !Number.isNaN(new Date(timestamp).getTime());
}

export function formatShortTime(timestamp: number): string {
  return isValidTimestamp(timestamp) ? timeFormatter.format(new Date(timestamp)) : "--:--";
}

export function formatShortDateTime(timestamp: number): string {
  return isValidTimestamp(timestamp) ? dateTimeFormatter.format(new Date(timestamp)) : "--";
}

export function formatTokenCount(count: number): string {
  if (count < 1_000) {
    return count.toString();
  }
  if (count < 10_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  if (count < 1_000_000) {
    return `${Math.round(count / 1_000)}k`;
  }
  if (count < 10_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  return `${Math.round(count / 1_000_000)}M`;
}
