const navigatorLocales =
  typeof navigator !== "undefined" && Array.isArray(navigator.languages)
    ? navigator.languages.filter(Boolean)
    : [];

const clientLocales =
  navigatorLocales.length > 0
    ? navigatorLocales
    : typeof navigator !== "undefined" && navigator.language
      ? [navigator.language]
      : undefined;

const timeFormatter = new Intl.DateTimeFormat(clientLocales, {
  hour: "2-digit",
  minute: "2-digit",
});

const dateTimeFormatter = new Intl.DateTimeFormat(clientLocales, {
  dateStyle: "short",
  timeStyle: "short",
});

export function formatShortTime(timestamp: number): string {
  return timeFormatter.format(new Date(timestamp));
}

export function formatShortDateTime(timestamp: number): string {
  return dateTimeFormatter.format(new Date(timestamp));
}
