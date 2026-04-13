export const NOTIFICATION_NAVIGATION_MESSAGE_TYPE = "notification-navigate";
export const NOTIFICATION_TARGET_QUERY_PARAM = "notificationTarget";

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

export function notificationLaunchUrl(
  url: string,
  origin = window.location.origin,
): string | undefined {
  const targetPath = notificationPathFromUrl(url, origin);
  if (!targetPath) {
    return undefined;
  }

  const launchUrl = new URL("/", origin);
  launchUrl.searchParams.set(NOTIFICATION_TARGET_QUERY_PARAM, targetPath);
  return launchUrl.href;
}

export function notificationTargetFromQuery(
  value: string | string[] | undefined,
  origin = window.location.origin,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return notificationPathFromUrl(value, origin);
}
