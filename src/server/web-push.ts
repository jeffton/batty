import fs from "node:fs/promises";
import path from "node:path";
import webpush from "web-push";
import { buildAgentCompletionNotificationContent } from "@/shared/agent-notification";
import type { SessionState } from "@/shared/types";
import type { AppConfig } from "./config";

interface StoredPushSubscription {
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

function isSubscription(candidate: unknown): candidate is StoredPushSubscription {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }

  const subscription = candidate as StoredPushSubscription;
  return (
    typeof subscription.endpoint === "string" &&
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
    typeof subscription.keys?.p256dh !== "string" ||
    typeof subscription.keys?.auth !== "string" ||
    !isBase64Url(subscription.keys.p256dh) ||
    !isBase64Url(subscription.keys.auth)
  ) {
    throw new Error("Invalid push subscription");
  }

  return {
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
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime,
    keys: subscription.keys,
  };
}

function isInvalidSubscriptionError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Unsupported characters set");
}

function sessionUrl(session: SessionState): string {
  return `/workspaces/${encodeURIComponent(session.workspaceId)}/sessions/${encodeURIComponent(session.sessionId)}`;
}

export class WebPushService {
  private readonly vapidKeysPath: string;
  private readonly subscriptionsPath: string;
  private readonly subject: string;
  private vapidKeys?: VapidKeys;

  constructor(config: AppConfig) {
    this.vapidKeysPath = path.join(config.webPushDir, "vapid-keys.json");
    this.subscriptionsPath = path.join(config.webPushDir, "subscriptions.json");
    this.subject = config.webPushSubject;
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
    const existing = await this.readSubscriptions();
    const previous = existing.find((candidate) => candidate.endpoint === next.endpoint);
    const merged: StoredPushSubscription = previous
      ? {
          ...next,
          createdAt: previous.createdAt,
          updatedAt: Date.now(),
        }
      : next;

    const subscriptions = [
      ...existing.filter((candidate) => candidate.endpoint !== merged.endpoint),
      merged,
    ];
    await this.writeSubscriptions(subscriptions);
  }

  async removeSubscription(endpoint: string): Promise<void> {
    const subscriptions = await this.readSubscriptions();
    const filtered = subscriptions.filter((candidate) => candidate.endpoint !== endpoint);
    if (filtered.length !== subscriptions.length) {
      await this.writeSubscriptions(filtered);
    }
  }

  async notifyAgentCompleted(session: SessionState): Promise<void> {
    const subscriptions = await this.readSubscriptions();
    if (subscriptions.length === 0) {
      return;
    }

    const content = buildAgentCompletionNotificationContent(session);
    const payload: PushNotificationPayload = {
      ...content,
      data: {
        url: sessionUrl(session),
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
      },
    };

    const staleEndpoints = new Set<string>();
    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
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
            staleEndpoints.add(subscription.endpoint);
            return;
          }
          throw error;
        }
      }),
    );

    if (staleEndpoints.size > 0) {
      await this.writeSubscriptions(
        subscriptions.filter((subscription) => !staleEndpoints.has(subscription.endpoint)),
      );
    }
  }

  private async loadVapidKeys(): Promise<VapidKeys> {
    const envPublicKey = process.env.PI_FACE_WEB_PUSH_PUBLIC_KEY;
    const envPrivateKey = process.env.PI_FACE_WEB_PUSH_PRIVATE_KEY;
    if (envPublicKey && envPrivateKey) {
      return {
        publicKey: envPublicKey,
        privateKey: envPrivateKey,
      };
    }

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
