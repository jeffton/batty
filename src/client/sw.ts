/// <reference lib="webworker" />

import { NOTIFICATION_NAVIGATION_MESSAGE_TYPE } from "@/client/lib/notification-navigation";
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

function normalizeBaseUrl(pathname: string): string {
  if (pathname === "/") {
    return "/";
  }
  return pathname.replace(/\/+$/, "") || "/";
}

function appBaseUrl(): string {
  return normalizeBaseUrl(new URL(self.registration.scope).pathname);
}

function withBaseUrl(pathname: string): string {
  const baseUrl = appBaseUrl();
  if (baseUrl === "/") {
    return pathname;
  }
  return pathname === "/" ? baseUrl : `${baseUrl}${pathname}`;
}

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
const baseUrl = appBaseUrl();
registerRoute(
  new NavigationRoute(createHandlerBoundToURL(withBaseUrl("/index.html")), {
    denylist: [new RegExp(`^${baseUrl === "/" ? "" : baseUrl}\\/api(?:\\/|$)`)],
  }),
);
registerRoute(
  ({ url }) => url.pathname.startsWith(withBaseUrl("/assets/")),
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
      : withBaseUrl("/"),
    self.location.origin,
  ).href;

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
        await routeClient(existingClient, targetUrl);
        return;
      }

      const opened = await self.clients.openWindow(targetUrl);
      if (opened && "focus" in opened && "navigate" in opened) {
        await routeClient(opened, targetUrl);
      }
    }),
  );
});
