import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  buildAgentCompletionNotification,
  primeAgentNotifications,
} from "@/client/lib/agent-notifications";
import type { SessionState } from "@/shared/types";

const baseSession: SessionState = {
  id: "web-1",
  sessionId: "session-1",
  workspaceId: "pi-face",
  cwd: "/root/github/pi-face",
  path: "/root/github/pi-face/.pi/session.jsonl",
  model: "anthropic/claude-sonnet-4",
  modelLabel: "Claude Sonnet 4 · anthropic",
  thinkingLevel: "medium",
  availableThinkingLevels: ["off", "medium"],
  isStreaming: false,
  pendingMessageCount: 0,
  updatedAt: 100,
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
  messages: [
    {
      id: "assistant-1",
      role: "assistant",
      timestamp: 100,
      blocks: [{ type: "text", text: "Done shipping the feature." }],
    },
  ],
  activeTools: [],
};

const originalNotification = globalThis.Notification;

afterEach(() => {
  if (originalNotification) {
    globalThis.Notification = originalNotification;
  } else {
    Reflect.deleteProperty(globalThis, "Notification");
  }

  vi.restoreAllMocks();
});

describe("buildAgentCompletionNotification", () => {
  it("uses the latest assistant message as the notification body", () => {
    expect(buildAgentCompletionNotification(baseSession)).toEqual(
      expect.objectContaining({
        title: "Pi is done · pi-face",
        body: "Done shipping the feature.",
        tag: "session-complete:session-1",
      }),
    );
  });
});

describe("primeAgentNotifications", () => {
  it("requests notification permission when still undecided", async () => {
    class MockNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = vi.fn().mockImplementation(async () => {
        MockNotification.permission = "granted";
        return "granted";
      });
    }

    const requestPermission = MockNotification.requestPermission;

    globalThis.Notification = MockNotification as unknown as typeof Notification;

    await expect(primeAgentNotifications()).resolves.toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("does not request permission after a denial", async () => {
    const requestPermission = vi.fn();

    class MockNotification {
      static permission: NotificationPermission = "denied";
      static requestPermission = requestPermission;
    }

    globalThis.Notification = MockNotification as unknown as typeof Notification;

    await expect(primeAgentNotifications()).resolves.toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
