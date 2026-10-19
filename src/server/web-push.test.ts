import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebPushService } from "@/server/web-push";
import type { AppConfig } from "@/server/config";
import type { SessionState } from "@/shared/types";

const webPushMocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
  generateVAPIDKeys: vi.fn(() => ({
    publicKey: "test-public-key",
    privateKey: "test-private-key",
  })),
}));

vi.mock("web-push", () => ({
  default: webPushMocks,
}));

function createConfig(webPushDir: string): AppConfig {
  return {
    host: "127.0.0.1",
    port: 3147,
    workspacesRoots: ["/tmp/workspaces"],
    selfPath: "/tmp/batty",
    battyDir: "/tmp",
    uploadsDir: "/tmp/uploads",
    sentFilesDir: "/tmp/sent-files",
    sitesDir: "/tmp/sites",
    publicDir: "/tmp/public",
    webPushDir,
    webPushSubject: "mailto:test@example.com",
    pushTitle: "Roy",
    cronDailySessionStartTime: "04:00",
    memoryModel: "openai-codex/gpt-6-luna",
    memoryLanguage: "English",
    browserMaxTabs: 16,
    baseUrl: "/",
    appTitle: "Batty",
    appColor: "neutral",
    cookieName: "batty-auth",
    authSecret: crypto.randomUUID(),
  };
}

function createSession(): SessionState {
  return {
    id: "session-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    cwd: "/tmp/workspace-1",
    thinkingLevel: "high",
    availableThinkingLevels: ["high"],
    isStreaming: false,
    pendingMessageCount: 0,
    updatedAt: Date.now(),
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    totalMessageCount: 0,
    hasMoreMessages: false,
    messages: [],
    activeTools: [],
  };
}

describe("WebPushService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-web-push-"));
    webPushMocks.sendNotification.mockReset();
    webPushMocks.setVapidDetails.mockReset();
    webPushMocks.generateVAPIDKeys.mockClear();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const subscription = (endpoint: string): PushSubscriptionJSON => ({
    endpoint,
    expirationTime: null,
    keys: { p256dh: "p256dh_key", auth: "auth-key" },
  });
  const persistedEndpoints = async () => {
    const stored = JSON.parse(
      await fs.readFile(path.join(tempDir, "subscriptions.json"), "utf8"),
    ) as { subscriptions: Array<{ endpoint: string }> };
    return stored.subscriptions.map((item) => item.endpoint).sort();
  };

  it.each([
    "not a URL",
    "http://fcm.googleapis.com/fcm/send/token",
    "https://localhost/push",
    "https://printer.local/push",
    "https://batty.tailnet.ts.net/push",
    "https://127.0.0.1/push",
    "https://2130706433/push",
    "https://10.0.0.1/push",
    "https://172.16.0.1/push",
    "https://192.168.1.1/push",
    "https://169.254.169.254/push",
    "https://100.64.0.1/push",
    "https://[::1]/push",
    "https://[fc00::1]/push",
    "https://[fe80::1]/push",
    "https://[::ffff:127.0.0.1]/push",
    "https://attacker.example/push",
    "https://fcm.googleapis.com.attacker.example/push",
    "https://fakepush.apple.com/push",
    "https://web.push.apple.com.attacker.example/push",
    "https://fcm.googleapis.com@127.0.0.1/push",
    "https://user:password@fcm.googleapis.com/push",
    "https://fcm.googleapis.com:8443/push",
    "https://fcm.googleapis.com/push#fragment",
  ])("rejects unsafe endpoint %s at registration and persisted delivery", async (endpoint) => {
    const service = new WebPushService(createConfig(tempDir));
    await expect(service.upsertSubscription(subscription(endpoint))).rejects.toThrow(
      "Invalid push subscription",
    );
    await expect(fs.stat(path.join(tempDir, "subscriptions.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fs.writeFile(
      path.join(tempDir, "subscriptions.json"),
      JSON.stringify({
        subscriptions: [{ ...subscription(endpoint), createdAt: 1, updatedAt: 1 }],
      }),
    );
    await service.notifyAgentCompleted(createSession());
    expect(webPushMocks.sendNotification).not.toHaveBeenCalled();
  });

  it.each([
    "https://fcm.googleapis.com/fcm/send/token",
    "https://updates.push.services.mozilla.com/wpush/v2/token",
    "https://web.push.apple.com/token",
    "https://region.web.push.apple.com/token",
    "https://FCM.GOOGLEAPIS.COM:443/fcm/send/token?key=value",
  ])("delivers supported provider endpoint %s", async (endpoint) => {
    const service = new WebPushService(createConfig(tempDir));
    await service.upsertSubscription(subscription(endpoint));
    await service.notifyAgentCompleted(createSession());
    expect(webPushMocks.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: new URL(endpoint).href }),
      expect.any(String),
      expect.any(Object),
    );
    await service.removeSubscription(endpoint);
    expect(await persistedEndpoints()).toEqual([]);
  });

  it("suppresses all owner devices for one visible client without deferring that message", async () => {
    const service = new WebPushService(createConfig(tempDir));
    await service.upsertSubscription(subscription("https://fcm.googleapis.com/phone"));
    await service.upsertSubscription(subscription("https://fcm.googleapis.com/desktop"));
    const hidden = service.foreground.connect(() => {});
    const visible = service.foreground.connect((event, data) => {
      if (event === "push-foreground") {
        const { clientId, challengeId } = data as { clientId: string; challengeId: string };
        service.foreground.acknowledge(clientId, challengeId);
      }
    });
    await service.notifyAgentCompleted(createSession());
    expect(webPushMocks.sendNotification).not.toHaveBeenCalled();
    hidden();
    visible();
    await service.notifyAgentCompleted({ ...createSession(), sessionId: "after-switch" });
    expect(webPushMocks.sendNotification).toHaveBeenCalledTimes(2);
    for (const call of webPushMocks.sendNotification.mock.calls) {
      expect(JSON.parse(call[1]).data.sessionId).toBe("after-switch");
      expect(call[2]).toEqual({ TTL: 60, urgency: "high" });
    }
  });

  it("delivers to every device after the foreground deadline when streams do not ack", async () => {
    const service = new WebPushService(createConfig(tempDir));
    await service.upsertSubscription(subscription("https://fcm.googleapis.com/phone"));
    await service.upsertSubscription(subscription("https://fcm.googleapis.com/desktop"));
    const disconnect = service.foreground.connect(() => {});
    await service.notifyAgentCompleted(createSession());
    expect(webPushMocks.sendNotification).toHaveBeenCalledTimes(2);
    disconnect();
  });

  it("uses the live global push title across workspaces", async () => {
    const config = createConfig(tempDir);
    const service = new WebPushService(config);
    await service.upsertSubscription(subscription("https://fcm.googleapis.com/title"));
    for (const workspaceId of ["first", "second"]) {
      await service.notifyAgentCompleted({
        ...createSession(),
        workspaceId,
        cwd: `/work/${workspaceId}`,
      });
    }
    config.pushTitle = "Custom title";
    await service.notifyAgentCompleted(createSession());
    expect(
      webPushMocks.sendNotification.mock.calls.map((call) => JSON.parse(call[1]).title),
    ).toEqual(["Roy", "Roy", "Custom title"]);
  });

  it("serializes concurrent registrations and deletions without losing devices", async () => {
    const service = new WebPushService(createConfig(tempDir));
    await service.upsertSubscription(subscription("https://fcm.googleapis.com/removed"));
    await Promise.all([
      service.upsertSubscription(subscription("https://fcm.googleapis.com/first")),
      service.removeSubscription("https://fcm.googleapis.com/removed"),
      service.upsertSubscription(subscription("https://fcm.googleapis.com/second")),
    ]);
    expect(await persistedEndpoints()).toEqual([
      "https://fcm.googleapis.com/first",
      "https://fcm.googleapis.com/second",
    ]);
  });

  it("cleans stale deliveries against current registrations, including same-endpoint replacement", async () => {
    const service = new WebPushService(createConfig(tempDir));
    for (const endpoint of [
      "https://fcm.googleapis.com/stale",
      "https://fcm.googleapis.com/replaced",
      "https://fcm.googleapis.com/refreshed",
      "https://fcm.googleapis.com/removed",
    ]) {
      await service.upsertSubscription(subscription(endpoint));
    }
    const rejectDelivery = new Map<string, (reason: unknown) => void>();
    webPushMocks.sendNotification.mockImplementation(
      ({ endpoint }: { endpoint: string }) =>
        new Promise((_, reject) => {
          rejectDelivery.set(endpoint, reject);
        }),
    );
    const delivery = service.notifyAgentCompleted(createSession());
    await vi.waitFor(() => expect(rejectDelivery.size).toBe(4));
    await service.upsertSubscription(subscription("https://fcm.googleapis.com/new"));
    await service.upsertSubscription(subscription("https://fcm.googleapis.com/refreshed"));
    await service.removeSubscription("https://fcm.googleapis.com/removed");
    await service.removeSubscription("https://fcm.googleapis.com/replaced");
    await service.upsertSubscription(subscription("https://fcm.googleapis.com/replaced"));
    for (const reject of rejectDelivery.values()) reject({ statusCode: 410 });
    await delivery;
    expect(await persistedEndpoints()).toEqual([
      "https://fcm.googleapis.com/new",
      "https://fcm.googleapis.com/refreshed",
      "https://fcm.googleapis.com/replaced",
    ]);
  });

  it("cleans invalid devices even when another delivery fails transiently", async () => {
    const service = new WebPushService(createConfig(tempDir));
    await service.upsertSubscription(subscription("https://fcm.googleapis.com/stale"));
    await service.upsertSubscription(subscription("https://fcm.googleapis.com/retry"));
    webPushMocks.sendNotification.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint === "https://fcm.googleapis.com/stale") throw { statusCode: 404 };
      throw new Error("temporary failure");
    });
    await expect(service.notifyAgentCompleted(createSession())).rejects.toThrow(
      "temporary failure",
    );
    expect(await persistedEndpoints()).toEqual(["https://fcm.googleapis.com/retry"]);
    await service.upsertSubscription(subscription("https://fcm.googleapis.com/new"));
    expect(await persistedEndpoints()).toEqual([
      "https://fcm.googleapis.com/new",
      "https://fcm.googleapis.com/retry",
    ]);
  });

  it("rejects subscriptions with non-base64url keys", async () => {
    const service = new WebPushService(createConfig(tempDir));
    await service.initialize();

    await expect(
      service.upsertSubscription({
        endpoint: "https://fcm.googleapis.com/subscription",
        expirationTime: null,
        keys: {
          p256dh: "bad+/key==",
          auth: "auth-key",
        },
      }),
    ).rejects.toThrow("Invalid push subscription");
  });

  it("skips malformed persisted subscriptions during delivery", async () => {
    const service = new WebPushService(createConfig(tempDir));
    await service.initialize();

    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "subscriptions.json"),
      `${JSON.stringify(
        {
          subscriptions: [
            {
              endpoint: "https://fcm.googleapis.com/invalid",
              expirationTime: null,
              keys: {
                p256dh: "bad+/key==",
                auth: "auth-key",
              },
              createdAt: 1,
              updatedAt: 1,
            },
            {
              endpoint: "https://fcm.googleapis.com/valid",
              expirationTime: null,
              keys: {
                p256dh: "p256dh_key",
                auth: "auth-key",
              },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    await service.notifyAgentCompleted(createSession());

    expect(webPushMocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(webPushMocks.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://fcm.googleapis.com/valid" }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it("drops subscriptions rejected by web-push for invalid character sets", async () => {
    const service = new WebPushService(createConfig(tempDir));
    await service.initialize();

    await service.upsertSubscription({
      endpoint: "https://fcm.googleapis.com/subscription",
      expirationTime: null,
      keys: {
        p256dh: "p256dh_key",
        auth: "auth-key",
      },
    });

    webPushMocks.sendNotification.mockRejectedValueOnce(
      new Error("Unsupported characters set use the URL or filename-safe Base64 characters set"),
    );

    await expect(service.notifyAgentCompleted(createSession())).resolves.toBeUndefined();

    const persisted = JSON.parse(
      await fs.readFile(path.join(tempDir, "subscriptions.json"), "utf8"),
    ) as { subscriptions: Array<{ endpoint: string }> };
    expect(persisted.subscriptions).toEqual([]);
  });

  it("does not send a push notification for subagent completions", async () => {
    const service = new WebPushService(createConfig(tempDir));
    await service.initialize();

    await service.upsertSubscription({
      endpoint: "https://fcm.googleapis.com/subscription",
      expirationTime: null,
      keys: {
        p256dh: "p256dh_key",
        auth: "auth-key",
      },
    });

    const session = createSession();
    session.isSubagentSession = true;

    await service.notifyAgentCompleted(session);

    expect(webPushMocks.sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify for an await handoff but notifies for its eventual reply", async () => {
    const service = new WebPushService(createConfig(tempDir));
    await service.initialize();
    await service.upsertSubscription({
      endpoint: "https://fcm.googleapis.com/subscription",
      expirationTime: null,
      keys: { p256dh: "p256dh_key", auth: "auth-key" },
    });
    const session = createSession();
    session.messages = [
      {
        id: "await-call",
        role: "assistant",
        turnPhase: "intermediate",
        timestamp: Date.now(),
        stopReason: "toolUse",
        blocks: [],
      },
      {
        id: "await-result",
        role: "toolResult",
        timestamp: Date.now() + 1,
        toolCallId: "await-child",
        toolName: "subagent",
        blocks: [{ type: "text", text: "Awaiting subagent child." }],
        isError: false,
      },
    ];
    await service.notifyAgentCompleted(session);
    expect(webPushMocks.sendNotification).not.toHaveBeenCalled();

    session.messages.push({
      id: "final-reply",
      role: "assistant",
      turnPhase: "final",
      timestamp: Date.now() + 2,
      stopReason: "stop",
      blocks: [{ type: "text", text: "The child finished." }],
    });
    await service.notifyAgentCompleted(session);
    expect(webPushMocks.sendNotification).toHaveBeenCalledOnce();
  });

  it("does not send a push notification for NO_REPLY completions", async () => {
    const service = new WebPushService(createConfig(tempDir));
    await service.initialize();

    await service.upsertSubscription({
      endpoint: "https://fcm.googleapis.com/subscription",
      expirationTime: null,
      keys: {
        p256dh: "p256dh_key",
        auth: "auth-key",
      },
    });

    const session = createSession();
    session.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        turnPhase: "final",
        timestamp: Date.now(),
        blocks: [{ type: "text", text: "NO_REPLY" }],
      },
    ];

    await service.notifyAgentCompleted(session);

    expect(webPushMocks.sendNotification).not.toHaveBeenCalled();
  });

  it("still sends a push notification when an older assistant message was NO_REPLY", async () => {
    const service = new WebPushService(createConfig(tempDir));
    await service.initialize();

    await service.upsertSubscription({
      endpoint: "https://fcm.googleapis.com/subscription",
      expirationTime: null,
      keys: {
        p256dh: "p256dh_key",
        auth: "auth-key",
      },
    });

    const session = createSession();
    session.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        turnPhase: "final",
        timestamp: Date.now(),
        blocks: [{ type: "text", text: "NO_REPLY" }],
      },
      {
        id: "user-1",
        role: "user",
        timestamp: Date.now() + 1,
        blocks: [{ type: "text", text: "Please run another check." }],
      },
    ];

    await service.notifyAgentCompleted(session);

    expect(webPushMocks.sendNotification).toHaveBeenCalledTimes(1);
  });
});
