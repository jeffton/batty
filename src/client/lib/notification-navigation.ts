import { del, get, set } from "idb-keyval";

export const NOTIFICATION_NAVIGATION_MESSAGE_TYPE = "notification-navigate";
export const NOTIFICATION_TARGET_QUERY_PARAM = "notificationTarget";
const PENDING_NOTIFICATION_TARGET_KEY = "batty:pending-notification-target";

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

export async function writePendingNotificationTarget(targetUrl: string): Promise<void> {
  const targetPath = notificationPathFromUrl(targetUrl, self.location.origin);
  if (!targetPath) {
    return;
  }

  await set(PENDING_NOTIFICATION_TARGET_KEY, targetPath);
}

export async function consumePendingNotificationTarget(): Promise<string | undefined> {
  const targetPath = await get<string>(PENDING_NOTIFICATION_TARGET_KEY);
  if (!targetPath) {
    return undefined;
  }

  await del(PENDING_NOTIFICATION_TARGET_KEY);
  return targetPath;
}
