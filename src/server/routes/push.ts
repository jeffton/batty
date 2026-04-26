import type { RouteContext } from "./context";

export function registerPushRoutes(context: RouteContext): void {
  const { app, webPush, routePath } = context;

  app.get(routePath("/api/push/public-key"), async () => ({ publicKey: webPush.getPublicKey() }));

  app.post<{ Body: { subscription?: PushSubscriptionJSON } }>(
    routePath("/api/push/subscriptions"),
    async (request) => {
      if (!request.body?.subscription) {
        throw new Error("Missing push subscription");
      }

      await webPush.upsertSubscription(request.body.subscription);
      return { ok: true };
    },
  );

  app.post<{ Body: { endpoint?: string } }>(
    routePath("/api/push/subscriptions/delete"),
    async (request) => {
      if (!request.body?.endpoint) {
        throw new Error("Missing push subscription endpoint");
      }

      await webPush.removeSubscription(request.body.endpoint);
      return { ok: true };
    },
  );
}
