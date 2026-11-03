/// <reference lib="webworker" />

import { NOTIFICATION_NAVIGATION_MESSAGE_TYPE } from "@/client/lib/notification-navigation";
import { cacheNames, clientsClaim, setCacheNameDetails } from "workbox-core";
import { registerRoute } from "workbox-routing";
import { NetworkFirst, StaleWhileRevalidate } from "workbox-strategies";
import { precacheAndRoute } from "workbox-precaching";

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

const cacheNamespace = `batty:${encodeURIComponent(self.registration.scope)}:`;
setCacheNameDetails({ prefix: cacheNamespace, suffix: "" });
self.skipWaiting();
// The browser only claims clients whose most-specific matching registration is this one.
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
// Workbox's cleanupOutdatedCaches uses a scope substring match, which lets a root
// registration delete nested registrations' precaches. Match our exact namespace instead.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(
              (name) =>
                name.startsWith(`${cacheNamespace}-precache-`) && name !== cacheNames.precache,
            )
            .map((name) => caches.delete(name)),
        ),
      ),
  );
});
const baseUrl = appBaseUrl();
const appShellUrl = withBaseUrl("/index.html");
const appShellCacheName = `${cacheNamespace}app-shell`;

function isAppUrl(url: URL): boolean {
  return (
    url.origin === self.location.origin &&
    (baseUrl === "/" || url.pathname === baseUrl || url.pathname.startsWith(`${baseUrl}/`))
  );
}

const appNavigationPaths = new Set(["/", "/login", "/memory-tree"].map(withBaseUrl));

function isAppNavigationUrl(url: URL): boolean {
  return isAppUrl(url) && appNavigationPaths.has(normalizeBaseUrl(url.pathname));
}

async function appClients(): Promise<WindowClient[]> {
  const clients = await self.clients.matchAll({ type: "window" });
  return clients.filter((client) => isAppNavigationUrl(new URL(client.url)));
}

async function isAppMessage(event: ExtendableMessageEvent): Promise<boolean> {
  if (!event.source || !("id" in event.source)) return false;
  const clientId = event.source.id;
  return (await appClients()).some((client) => client.id === clientId);
}

async function cacheAppShell(): Promise<void> {
  const response = await fetch(appShellUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`App shell: HTTP ${response.status}`);
  const cache = await caches.open(appShellCacheName);
  await cache.put(appShellUrl, response);
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheAppShell());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "refresh-app-shell") {
    event.waitUntil(isAppMessage(event).then((allowed) => (allowed ? cacheAppShell() : undefined)));
  }
});

registerRoute(
  // Root and parent registrations can control a child's first visit before its
  // worker exists. Only our actual router paths may populate our shared shell key.
  ({ request, url }) => request.mode === "navigate" && isAppNavigationUrl(url),
  new NetworkFirst({
    cacheName: appShellCacheName,
    networkTimeoutSeconds: 2,
    plugins: [{ cacheKeyWillBeUsed: async () => appShellUrl }],
  }),
);
registerRoute(
  ({ url }) => isAppUrl(url) && url.pathname.startsWith(withBaseUrl("/assets/")),
  new StaleWhileRevalidate({
    cacheName: `${cacheNamespace}static-assets`,
  }),
);

const previewPrefix = `${cacheNamespace}private-image-previews:`;
const permissionCacheName = `${previewPrefix}permissions`;
const permissionKey = (clientId: string) =>
  new Request(
    new URL(withBaseUrl(`/api/local-preview-permission/${clientId}`), self.location.origin),
  );
const previewLock = <T>(action: () => Promise<T>) =>
  navigator.locks.request(`${cacheNamespace}private-previews`, action);
async function permissionEpoch(cache: Cache): Promise<string | null | undefined> {
  const marker = await cache.match(permissionKey("epoch"));
  return marker ? (await marker.json()).cacheEpoch : undefined;
}
self.addEventListener("message", (event) => {
  if (event.data?.type === "authorize-private-previews" && event.source && "id" in event.source) {
    const clientId = event.source.id;
    event.waitUntil(
      isAppMessage(event).then((allowed) => {
        if (!allowed) return;
        return previewLock(async () => {
          const cache = await caches.open(permissionCacheName);
          const epoch = await permissionEpoch(cache);
          if (epoch !== undefined && epoch !== event.data.cacheEpoch) return;
          if (epoch === undefined)
            await cache.put(
              permissionKey("epoch"),
              new Response(JSON.stringify({ cacheEpoch: event.data.cacheEpoch })),
            );
          await cache.put(
            permissionKey(clientId),
            new Response(
              JSON.stringify({
                scope: event.data.scope,
                expiresAt: event.data.expiresAt,
                cacheEpoch: event.data.cacheEpoch,
              }),
            ),
          );
          const keys = (await cache.keys()).filter((key) => key.url !== permissionKey("epoch").url);
          for (const key of keys.slice(0, Math.max(0, keys.length - 128))) await cache.delete(key);
        });
      }),
    );
  }
  if (event.data?.type === "clear-private-previews") {
    event.waitUntil(
      isAppMessage(event)
        .then(async (allowed) => {
          if (!allowed) throw new Error("Private preview message is outside this installation");
          await previewLock(async () => {
            for (const name of await caches.keys())
              if (name.startsWith(previewPrefix) && name !== permissionCacheName)
                await caches.delete(name);
            const cache = await caches.open(permissionCacheName);
            for (const key of await cache.keys()) await cache.delete(key);
            await cache.put(
              permissionKey("epoch"),
              new Response(JSON.stringify({ cacheEpoch: event.data.cacheEpoch })),
            );
          });
        })
        .then(
          () => {
            event.ports[0]?.postMessage({ ok: true });
          },
          (error) => {
            event.ports[0]?.postMessage({ error: String(error) });
            throw error;
          },
        ),
    );
  }
});
registerRoute(
  ({ url }) =>
    url.origin === self.location.origin &&
    url.pathname.startsWith(withBaseUrl("/api/")) &&
    url.searchParams.get("preview") === "1",
  async (options) => {
    const clientId = (options.event as FetchEvent).clientId;
    const admitted = await previewLock(async () => {
      const permissions = await caches.open(permissionCacheName);
      const cacheEpoch = await permissionEpoch(permissions);
      const unadmitted = { cacheEpoch, cacheName: undefined, cached: undefined };
      const stored = await permissions.match(permissionKey(clientId));
      if (!stored) return unadmitted;
      const permission = (await stored.json()) as {
        scope: string;
        expiresAt: number;
        cacheEpoch: string | null;
      };
      if (
        !permission.scope ||
        permission.expiresAt <= Date.now() ||
        permission.cacheEpoch !== cacheEpoch
      )
        return unadmitted;
      const cacheName = `${previewPrefix}${permission.scope}`;
      return {
        ...permission,
        cacheName,
        cached: await (await caches.open(cacheName)).match(options.request),
      };
    });
    if (admitted.cached) return admitted.cached;
    const response = await fetch(options.request, { cache: "no-store" });
    return previewLock(async () => {
      if (admitted.cacheEpoch !== (await permissionEpoch(await caches.open(permissionCacheName))))
        return new Response("Preview access revoked", { status: 401 });
      if (response.ok && admitted.cacheName) {
        const cache = await caches.open(admitted.cacheName);
        await cache.put(options.request, response.clone());
        const keys = await cache.keys();
        for (const key of keys.slice(0, Math.max(0, keys.length - 128))) await cache.delete(key);
      }
      return response;
    });
  },
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
  );
  if (!isAppNavigationUrl(targetUrl))
    throw new Error("Notification URL is outside this installation");

  event.waitUntil(
    appClients().then(async (clients) => {
      for (const client of clients) {
        notifyClient(client, targetUrl.href);
      }

      const existingClient = clients[0];
      if (existingClient) {
        await routeClient(existingClient, targetUrl.href);
        return;
      }

      const opened = await self.clients.openWindow(targetUrl.href);
      if (opened) {
        await routeClient(opened, targetUrl.href);
      }
    }),
  );
});
