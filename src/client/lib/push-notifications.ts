import { deletePushSubscription, getPushPublicKey, savePushSubscription } from "@/client/lib/api";
import { getAppServiceWorkerRegistration } from "./service-worker";

function decodeBase64Url(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const binary = window.atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer;
}

export function supportsWebPush(): boolean {
  return (
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "showNotification" in ServiceWorkerRegistration.prototype
  );
}

let subscriptionQueue: Promise<unknown> = Promise.resolve();

function serializeSubscription<T>(operation: () => Promise<T>): Promise<T> {
  const result = subscriptionQueue.then(operation);
  subscriptionQueue = result.catch(() => {});
  return result;
}

export function syncPushSubscription(requestPermission: boolean): Promise<boolean> {
  return serializeSubscription(() => syncSubscription(requestPermission));
}

export function unregisterPushSubscription(): Promise<void> {
  return serializeSubscription(async () => {
    if (!supportsWebPush()) return;
    const registration = await getAppServiceWorkerRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await deletePushSubscription(subscription.endpoint);
    await subscription.unsubscribe();
  });
}

async function syncSubscription(requestPermission: boolean): Promise<boolean> {
  if (!supportsWebPush()) {
    return false;
  }

  const registration = await getAppServiceWorkerRegistration();
  if (!registration) return false;
  const worker = registration.active ?? registration.installing ?? registration.waiting;
  if (!worker) return false;
  if (worker.state !== "activated") {
    await new Promise<void>((resolve, reject) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
        else if (worker.state === "redundant")
          reject(new Error("Push service worker became redundant"));
      });
    });
  }
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
