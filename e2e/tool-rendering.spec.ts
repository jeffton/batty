import { expect, test, type Page } from "@playwright/test";
import type { SessionState, SessionSummary, WorkspaceInfo } from "@/shared/types";

declare global {
  interface Window {
    __emitSse: (payload: unknown) => void;
  }
}

const workspace: WorkspaceInfo = {
  id: "pi-face",
  label: "pi-face",
  path: "/root/github/pi-face",
  kind: "self",
};

const summary: SessionSummary = {
  id: "/tmp/session-1.jsonl",
  sessionId: "session-1",
  name: "tool rendering",
  path: "/tmp/session-1.jsonl",
  firstMessage: "tool rendering",
  updatedAt: 1,
  messageCount: 1,
  workspaceId: workspace.id,
};

function createSession(partial: Partial<SessionState>): SessionState {
  return {
    id: "web-1",
    sessionId: summary.sessionId,
    workspaceId: workspace.id,
    cwd: workspace.path,
    path: summary.path,
    thinkingLevel: "medium",
    availableThinkingLevels: ["off", "low", "medium", "high"],
    isStreaming: false,
    pendingMessageCount: 0,
    updatedAt: 1,
    contextTokens: 100,
    contextWindow: 1000,
    contextPercent: 10,
    messages: [],
    activeTools: [],
    ...partial,
  };
}

async function installMocks(page: Page, session: SessionState): Promise<void> {
  await page.addInitScript(() => {
    const sources: Array<{
      onmessage: ((event: { data: string }) => void) | null;
      onerror: (() => void) | null;
      close: () => void;
    }> = [];

    class FakeEventSource {
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(_url: string) {
        sources.push(this);
      }

      close() {}
    }

    Object.defineProperty(window, "EventSource", {
      configurable: true,
      writable: true,
      value: FakeEventSource,
    });

    window.__emitSse = (payload: unknown) => {
      const source = sources.at(-1);
      source?.onmessage?.({ data: JSON.stringify(payload) });
    };
  });

  await page.route("**/api/bootstrap", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        workspaces: [workspace],
        models: [],
      }),
    });
  });

  await page.route(`**/api/workspaces/${workspace.id}/sessions`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([summary]),
    });
  });

  await page.route("**/api/sessions/open", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });
}

test.describe("tool rendering", () => {
  test("renders standalone bash tool results", async ({ page }) => {
    await installMocks(
      page,
      createSession({
        messages: [
          {
            id: "tool-1",
            role: "toolResult",
            timestamp: 2,
            toolCallId: "call-1",
            toolName: "bash",
            blocks: [{ type: "text", text: "M src/client/components/ToolCallBlock.vue" }],
            isError: false,
          },
        ],
      }),
    );

    await page.goto(`/workspaces/${workspace.id}/sessions/${summary.sessionId}`);

    await expect(page.locator(".chat-main__transcript")).toBeVisible();
    await expect(page.locator(".tool-call .code-block")).toContainText(
      "M src/client/components/ToolCallBlock.vue",
    );
  });

  test("keeps bash command and running output in one block", async ({ page }) => {
    await installMocks(page, createSession({ messages: [] }));

    await page.goto(`/workspaces/${workspace.id}/sessions/${summary.sessionId}`);
    await expect(page.locator(".chat-main__transcript")).toBeVisible();

    await page.evaluate(() => {
      window.__emitSse({
        type: "assistant",
        assistant: {
          id: "assistant-1",
          role: "assistant",
          timestamp: 3,
          blocks: [
            { type: "text", text: "Running command" },
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "git status --short", timeout: 600 },
            },
          ],
        },
      });
      window.__emitSse({
        type: "tools",
        tools: [
          {
            toolCallId: "call-1",
            toolName: "bash",
            args: { command: "git status --short", timeout: 600 },
            blocks: [{ type: "text", text: "M src/client/views/ChatView.vue" }],
            status: "running",
            isError: false,
          },
        ],
      });
    });

    await expect(page.locator(".tool-call")).toHaveCount(1);
    await expect(page.locator(".tool-call .code-block")).toContainText("$ git status --short");
    await expect(page.locator(".tool-call .code-block")).toContainText(
      "M src/client/views/ChatView.vue",
    );
  });

  test("keeps the completed bash result attached to the same block", async ({ page }) => {
    await installMocks(page, createSession({ messages: [] }));

    await page.goto(`/workspaces/${workspace.id}/sessions/${summary.sessionId}`);
    await expect(page.locator(".chat-main__transcript")).toBeVisible();

    await page.evaluate(() => {
      window.__emitSse({
        type: "assistant",
        assistant: {
          id: "assistant-1",
          role: "assistant",
          timestamp: 3,
          blocks: [
            { type: "text", text: "Running command" },
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "git status --short", timeout: 600 },
            },
          ],
        },
      });
      window.__emitSse({
        type: "tools",
        tools: [
          {
            toolCallId: "call-1",
            toolName: "bash",
            args: { command: "git status --short", timeout: 600 },
            blocks: [{ type: "text", text: "M src/client/views/ChatView.vue" }],
            status: "running",
            isError: false,
          },
        ],
      });
      window.__emitSse({
        type: "state",
        state: {
          id: "web-1",
          sessionId: "session-1",
          workspaceId: "pi-face",
          cwd: "/root/github/pi-face",
          path: "/tmp/session-1.jsonl",
          thinkingLevel: "medium",
          availableThinkingLevels: ["off", "low", "medium", "high"],
          isStreaming: false,
          pendingMessageCount: 0,
          updatedAt: 4,
          contextTokens: 100,
          contextWindow: 1000,
          contextPercent: 10,
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              timestamp: 3,
              blocks: [
                { type: "text", text: "Running command" },
                {
                  type: "toolCall",
                  id: "call-1",
                  name: "bash",
                  arguments: { command: "git status --short", timeout: 600 },
                },
              ],
            },
            {
              id: "tool-1",
              role: "toolResult",
              timestamp: 4,
              toolCallId: "call-1",
              toolName: "bash",
              blocks: [{ type: "text", text: "M src/client/views/ChatView.vue" }],
              isError: false,
            },
          ],
          activeTools: [],
        },
      });
    });

    await expect(page.locator(".tool-call")).toHaveCount(1);
    await expect(page.locator(".tool-call .code-block")).toContainText("$ git status --short");
    await expect(page.locator(".tool-call .code-block")).toContainText(
      "M src/client/views/ChatView.vue",
    );
  });
});
