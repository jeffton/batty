export async function primeAgentNotifications(): Promise<boolean> {
  if (!("Notification" in window)) {
    return false;
  }

  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }

  return Notification.permission === "granted";
}
