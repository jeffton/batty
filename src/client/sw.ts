/// <reference lib="webworker" />

import {
  NOTIFICATION_NAVIGATION_MESSAGE_TYPE,
  notificationLaunchUrl,
} from "@/client/lib/notification-navigation";
import { clientsClaim } from "workbox-core";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { StaleWhileRevalidate } from "workbox-strategies";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";

declare let self: ServiceWorkerGlobalScope;

type PushNotificationPayload = NotificationOptions & {
  title?: string;
  body?: string;
  tag?: string;
  icon?: string;
  badge?: string;
  data?: {
    url?: string;
    [key: string]: unknown;
  };
};

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function navigateClient(client: WindowClient, targetUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await client.navigate(targetUrl);
      return;
    } catch {
      await sleep(200);
    }
  }
}

function notifyClient(client: WindowClient, targetUrl: string): void {
  client.postMessage({
    type: NOTIFICATION_NAVIGATION_MESSAGE_TYPE,
    url: targetUrl,
  });
}

async function routeClient(client: WindowClient, targetUrl: string): Promise<void> {
  notifyClient(client, targetUrl);
  await navigateClient(client, targetUrl);
  await client.focus();
  notifyClient(client, targetUrl);
}

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api/],
  }),
);
registerRoute(
  ({ url }) => url.pathname.startsWith("/assets/"),
  new StaleWhileRevalidate({
    cacheName: "static-assets",
  }),
);

self.addEventListener("push", (event) => {
  const payload = event.data?.json() as PushNotificationPayload | undefined;
  if (!payload) {
    throw new Error("Missing push payload");
  }

  const { title, ...options } = payload;
  if (typeof title !== "string") {
    throw new Error("Missing push title");
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.preventDefault();
  event.notification.close();
  const targetUrl = new URL(
    typeof event.notification.data?.url === "string" && event.notification.data.url.length > 0
      ? event.notification.data.url
      : "/",
    self.location.origin,
  ).href;
  const launchUrl = notificationLaunchUrl(targetUrl, self.location.origin) ?? targetUrl;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const sameOriginClients = clients.filter(
        (client): client is WindowClient => new URL(client.url).origin === self.location.origin,
      );

      for (const client of sameOriginClients) {
        notifyClient(client, targetUrl);
      }

      const existingClient = sameOriginClients.find(
        (client) => "navigate" in client && "focus" in client,
      );
      if (existingClient) {
        await routeClient(existingClient, launchUrl);
        return;
      }

      const opened = await self.clients.openWindow(launchUrl);
      if (opened && "focus" in opened && "navigate" in opened) {
        await routeClient(opened, targetUrl);
      }
    }),
  );
});
