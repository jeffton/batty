/// <reference lib="webworker" />

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
  const payload = (event.data?.json() ?? {}) as PushNotificationPayload;
  const title = payload.title ?? "Pi is done";
  const { title: _title, ...options } = payload;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl =
    typeof event.notification.data?.url === "string" && event.notification.data.url.length > 0
      ? event.notification.data.url
      : "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (!("focus" in client) || !("navigate" in client)) {
          continue;
        }

        if (new URL(client.url).origin !== self.location.origin) {
          continue;
        }

        return client.focus().then(() => client.navigate(targetUrl));
      }

      return self.clients.openWindow(targetUrl);
    }),
  );
});
