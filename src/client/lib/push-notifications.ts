import { deletePushSubscription, getPushPublicKey, savePushSubscription } from "@/client/lib/api";

function decodeBase64Url(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4 || 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const binary = window.atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function supportsWebPush(): boolean {
  return (
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "showNotification" in ServiceWorkerRegistration.prototype
  );
}

export async function syncPushSubscription(requestPermission: boolean): Promise<boolean> {
  if (!supportsWebPush()) {
    return false;
  }

  const registration = await navigator.serviceWorker.ready;
  if (requestPermission && Notification.permission === "default") {
    await Notification.requestPermission();
  }

  if (Notification.permission !== "granted") {
    const existingSubscription = await registration.pushManager.getSubscription();
    const endpoint = existingSubscription?.endpoint;
    if (endpoint) {
      await deletePushSubscription(endpoint);
    }
    return false;
  }

  const { publicKey } = await getPushPublicKey();
  const existingSubscription = await registration.pushManager.getSubscription();
  const subscription =
    existingSubscription ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(publicKey),
    }));
  const subscriptionJson = subscription.toJSON();
  await savePushSubscription(subscriptionJson);
  return true;
}
