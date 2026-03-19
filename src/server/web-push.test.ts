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
    workspacesRoot: "/tmp/workspaces",
    selfPath: "/tmp/batty",
    uploadsDir: "/tmp/uploads",
    publicDir: "/tmp/public",
    webPushDir,
    webPushSubject: "mailto:test@example.com",
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

  it("rejects subscriptions with non-base64url keys", async () => {
    const service = new WebPushService(createConfig(tempDir));
    await service.initialize();

    await expect(
      service.upsertSubscription({
        endpoint: "https://push.example/subscription",
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
              endpoint: "https://push.example/invalid",
              expirationTime: null,
              keys: {
                p256dh: "bad+/key==",
                auth: "auth-key",
              },
              createdAt: 1,
              updatedAt: 1,
            },
            {
              endpoint: "https://push.example/valid",
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
      expect.objectContaining({ endpoint: "https://push.example/valid" }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it("drops subscriptions rejected by web-push for invalid character sets", async () => {
    const service = new WebPushService(createConfig(tempDir));
    await service.initialize();

    await service.upsertSubscription({
      endpoint: "https://push.example/subscription",
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
});
