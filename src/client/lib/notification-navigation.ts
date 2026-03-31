export const NOTIFICATION_NAVIGATION_MESSAGE_TYPE = "notification-navigate";

export interface NotificationNavigationMessage {
  type: typeof NOTIFICATION_NAVIGATION_MESSAGE_TYPE;
  url: string;
}

export function notificationPathFromUrl(
  url: string,
  origin = window.location.origin,
): string | undefined {
  try {
    const target = new URL(url, origin);
    if (target.origin !== origin) {
      return undefined;
    }
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return undefined;
  }
}
