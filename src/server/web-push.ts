import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import webpush from "web-push";
import { PushForeground } from "./push-foreground";
import {
  buildAgentCompletionNotificationContent,
  suppressAgentCompletionNotification,
} from "@/shared/agent-notification";
import type { SessionState } from "@/shared/types";
import type { AppConfig } from "./config";

interface StoredPushSubscription {
  revision?: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  expirationTime: number | null;
  createdAt: number;
  updatedAt: number;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface PersistedSubscriptions {
  subscriptions: StoredPushSubscription[];
}

interface PushNotificationPayload {
  title: string;
  body: string;
  tag: string;
  icon: string;
  badge: string;
  data: {
    url: string;
    sessionId: string;
    workspaceId: string;
  };
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function isPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    // Restrict delivery to browser push providers rather than arbitrary HTTPS hosts.
    // Apple documents any subdomain: https://webkit.org/blog/12945/meet-web-push/
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      (url.hostname === "fcm.googleapis.com" ||
        url.hostname === "updates.push.services.mozilla.com" ||
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+push\.apple\.com$/.test(url.hostname))
    );
  } catch {
    return false;
  }
}

function isSubscription(candidate: unknown): candidate is StoredPushSubscription {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }

  const subscription = candidate as StoredPushSubscription;
  return (
    typeof subscription.endpoint === "string" &&
    isPushEndpoint(subscription.endpoint) &&
    typeof subscription.keys?.p256dh === "string" &&
    typeof subscription.keys?.auth === "string" &&
    isBase64Url(subscription.keys.p256dh) &&
    isBase64Url(subscription.keys.auth) &&
    (typeof subscription.expirationTime === "number" || subscription.expirationTime === null) &&
    typeof subscription.createdAt === "number" &&
    typeof subscription.updatedAt === "number"
  );
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function toStoredPushSubscription(
  subscription: PushSubscriptionJSON,
  now = Date.now(),
): StoredPushSubscription {
  if (
    typeof subscription.endpoint !== "string" ||
    !isPushEndpoint(subscription.endpoint) ||
    typeof subscription.keys?.p256dh !== "string" ||
    typeof subscription.keys?.auth !== "string" ||
    !isBase64Url(subscription.keys.p256dh) ||
    !isBase64Url(subscription.keys.auth)
  ) {
    throw new Error("Invalid push subscription");
  }

  return {
    revision: randomUUID(),
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
    expirationTime:
      typeof subscription.expirationTime === "number" ? subscription.expirationTime : null,
    createdAt: now,
    updatedAt: now,
  };
}

function toWebPushSubscription(subscription: StoredPushSubscription): webpush.PushSubscription {
  return {
    // Match validation's URL interpretation; web-push itself uses legacy url.parse.
    endpoint: new URL(subscription.endpoint).href,
    expirationTime: subscription.expirationTime,
    keys: subscription.keys,
  };
}

function isInvalidSubscriptionError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Unsupported characters set");
}

function sessionUrl(baseUrl: string): string {
  return baseUrl === "/" ? "/" : `${baseUrl}/`;
}

export class WebPushService {
  readonly foreground = new PushForeground();

  private readonly vapidKeysPath: string;
  private readonly subscriptionsPath: string;
  private readonly subject: string;
  private readonly baseUrl: string;
  private vapidKeys?: VapidKeys;
  private subscriptionsQueue: Promise<unknown> = Promise.resolve();

  private serializeSubscriptions<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.subscriptionsQueue.then(operation);
    // A failed operation must reject its caller without blocking later operations.
    this.subscriptionsQueue = result.catch(() => {});
    return result;
  }

  constructor(private readonly config: AppConfig) {
    this.vapidKeysPath = path.join(config.webPushDir, "vapid-keys.json");
    this.subscriptionsPath = path.join(config.webPushDir, "subscriptions.json");
    this.subject = config.webPushSubject;
    this.baseUrl = config.baseUrl;
  }

  async initialize(): Promise<void> {
    this.vapidKeys = await this.loadVapidKeys();
    webpush.setVapidDetails(this.subject, this.vapidKeys.publicKey, this.vapidKeys.privateKey);
  }

  getPublicKey(): string {
    if (!this.vapidKeys) {
      throw new Error("Web push service not initialized");
    }

    return this.vapidKeys.publicKey;
  }

  async upsertSubscription(subscription: PushSubscriptionJSON): Promise<void> {
    const next = toStoredPushSubscription(subscription);
    await this.serializeSubscriptions(async () => {
      const existing = await this.readSubscriptions();
      const previous = existing.find((candidate) => candidate.endpoint === next.endpoint);
      const merged: StoredPushSubscription = previous
        ? {
            ...next,
            createdAt: previous.createdAt,
            updatedAt: Math.max(Date.now(), previous.updatedAt + 1),
          }
        : next;

      const subscriptions = [
        ...existing.filter((candidate) => candidate.endpoint !== merged.endpoint),
        merged,
      ];
      await this.writeSubscriptions(subscriptions);
    });
  }

  async removeSubscription(endpoint: string): Promise<void> {
    await this.serializeSubscriptions(async () => {
      const subscriptions = await this.readSubscriptions();
      const filtered = subscriptions.filter((candidate) => candidate.endpoint !== endpoint);
      if (filtered.length !== subscriptions.length) {
        await this.writeSubscriptions(filtered);
      }
    });
  }

  async notifyAgentCompleted(session: SessionState): Promise<void> {
    if (suppressAgentCompletionNotification(session)) {
      console.info("Skipping web push notification for suppressed completion", {
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
      });
      return;
    }

    const subscriptions = await this.serializeSubscriptions(() => this.readSubscriptions());
    if (subscriptions.length === 0 || (await this.foreground.isVisible())) {
      return;
    }

    const content = buildAgentCompletionNotificationContent(session, this.config.pushTitle);
    const payload: PushNotificationPayload = {
      ...content,
      data: {
        url: sessionUrl(this.baseUrl),
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
      },
    };

    const staleSubscriptions = new Map<string, StoredPushSubscription>();
    const results = await Promise.allSettled(
      subscriptions.map(async (subscription) => {
        try {
          // web-push uses https.request and rejects non-2xx responses without
          // following redirects. Regression tests cover this transport behavior.
          await webpush.sendNotification(
            toWebPushSubscription(subscription),
            JSON.stringify(payload),
            {
              TTL: 60,
              urgency: "high",
            },
          );
          console.info("Sent web push notification", {
            endpoint: subscription.endpoint,
            tag: payload.tag,
            sessionId: session.sessionId,
          });
        } catch (error) {
          const statusCode =
            typeof error === "object" && error && "statusCode" in error
              ? Number((error as { statusCode?: unknown }).statusCode)
              : undefined;
          if (statusCode === 404 || statusCode === 410 || isInvalidSubscriptionError(error)) {
            staleSubscriptions.set(subscription.endpoint, subscription);
            return;
          }
          throw error;
        }
      }),
    );

    if (staleSubscriptions.size > 0) {
      await this.serializeSubscriptions(async () => {
        const current = await this.readSubscriptions();
        const filtered = current.filter((subscription) => {
          const stale = staleSubscriptions.get(subscription.endpoint);
          return !stale || JSON.stringify(stale) !== JSON.stringify(subscription);
        });
        if (filtered.length !== current.length) await this.writeSubscriptions(filtered);
      });
    }
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  private async loadVapidKeys(): Promise<VapidKeys> {
    const existing = await readJsonFile<VapidKeys | undefined>(this.vapidKeysPath, undefined);
    if (existing?.publicKey && existing?.privateKey) {
      return existing;
    }

    const generated = webpush.generateVAPIDKeys();
    await writeJsonFile(this.vapidKeysPath, generated);
    return generated;
  }

  private async readSubscriptions(): Promise<StoredPushSubscription[]> {
    const persisted = await readJsonFile<PersistedSubscriptions>(this.subscriptionsPath, {
      subscriptions: [],
    });
    return Array.isArray(persisted.subscriptions)
      ? persisted.subscriptions.filter(isSubscription)
      : [];
  }

  private async writeSubscriptions(subscriptions: StoredPushSubscription[]): Promise<void> {
    await writeJsonFile(this.subscriptionsPath, { subscriptions });
  }
}
