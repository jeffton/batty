import { buildAgentCompletionNotificationContent } from "@/shared/agent-notification";
import type { SessionState } from "@/shared/types";

export function buildAgentCompletionNotification(
  session: SessionState,
): NotificationOptions & { title: string } {
  return buildAgentCompletionNotificationContent(session);
}

export async function primeAgentNotifications(): Promise<boolean> {
  if (!("Notification" in window)) {
    return false;
  }

  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }

  return Notification.permission === "granted";
}
