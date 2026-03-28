import { expect, test, type Page } from "@playwright/test";
import type { SessionState, SessionSummary, WorkspaceInfo } from "@/shared/types";

declare global {
  interface Window {
    __emitSse: (payload: unknown) => void;
  }
}

const workspace: WorkspaceInfo = {
  id: "batty",
  label: "batty",
  path: "/root/github/batty",
  kind: "workspace",
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
  const session = {
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
    totalMessageCount: 0,
    hasMoreMessages: false,
    messages: [],
    activeTools: [],
    ...partial,
  };

  return {
    ...session,
    totalMessageCount: partial.totalMessageCount ?? session.messages.length,
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

  await page.route(`**/api/workspaces/${workspace.id}/cron-jobs`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/sessions/open", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });
}

function createMessages(count: number): SessionState["messages"] {
  return Array.from({ length: count }, (_, index) => ({
    id: `assistant-${index + 1}`,
    role: "assistant" as const,
    timestamp: index + 1,
    blocks: [{ type: "text", text: `message-${index + 1}` }],
  }));
}

test.describe("tool rendering", () => {
  test("loads older messages when the initial transcript is paginated", async ({ page }) => {
    await page.route("**/api/sessions/web-1/messages**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          messages: [
            {
              id: "user-1",
              role: "user",
              timestamp: 1,
              blocks: [{ type: "text", text: "oldest prompt" }],
            },
          ],
          totalMessageCount: 3,
          hasMoreMessages: false,
        }),
      });
    });

    await installMocks(
      page,
      createSession({
        totalMessageCount: 3,
        hasMoreMessages: true,
        messages: [
          {
            id: "assistant-2",
            role: "assistant",
            timestamp: 2,
            blocks: [{ type: "text", text: "middle reply" }],
          },
          {
            id: "assistant-3",
            role: "assistant",
            timestamp: 3,
            blocks: [{ type: "text", text: "latest reply" }],
          },
        ],
      }),
    );

    await page.goto(`/workspaces/${workspace.id}/sessions/${summary.sessionId}`);

    await expect(page.locator(".transcript")).toBeVisible();
    await expect(page.locator(".message")).toContainText(["oldest prompt", "latest reply"]);
  });

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

    await expect(page.locator(".transcript")).toBeVisible();
    await expect(page.locator(".tool-call .code-block")).toContainText(
      "M src/client/components/ToolCallBlock.vue",
    );
  });

  test("keeps bash command and running output in one block", async ({ page }) => {
    await installMocks(page, createSession({ messages: [] }));

    await page.goto(`/workspaces/${workspace.id}/sessions/${summary.sessionId}`);
    await expect(page.locator(".transcript")).toBeVisible();

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
    await expect(page.locator(".tool-call .code-block").first()).toContainText(
      "$ git status --short",
    );
    await expect(page.locator(".tool-call .code-block").last()).toContainText(
      "M src/client/views/ChatView.vue",
    );
  });

  test("keeps the completed bash result attached to the same block", async ({ page }) => {
    await installMocks(page, createSession({ messages: [] }));

    await page.goto(`/workspaces/${workspace.id}/sessions/${summary.sessionId}`);
    await expect(page.locator(".transcript")).toBeVisible();

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
          workspaceId: "batty",
          cwd: "/root/github/batty",
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
    await expect(page.locator(".tool-call .code-block").first()).toContainText(
      "$ git status --short",
    );
    await expect(page.locator(".tool-call .code-block").last()).toContainText(
      "M src/client/views/ChatView.vue",
    );
  });

  test("keeps following streaming output while already pinned to the bottom", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await installMocks(
      page,
      createSession({
        messages: createMessages(30),
      }),
    );

    await page.goto(`/workspaces/${workspace.id}/sessions/${summary.sessionId}`);
    await expect(page.locator(".transcript")).toBeVisible();

    await expect(page.locator(".message").last()).toContainText("message-30");

    await page.evaluate(() => {
      window.__emitSse({
        type: "status",
        isStreaming: true,
        pendingMessageCount: 0,
      });
      window.__emitSse({
        type: "assistant",
        assistant: {
          id: "assistant-stream",
          role: "assistant",
          timestamp: 31,
          blocks: [
            { type: "text", text: "Running command" },
            {
              type: "toolCall",
              id: "call-stream",
              name: "bash",
              arguments: { command: "pnpm test" },
            },
          ],
        },
      });
      window.__emitSse({
        type: "tools",
        tools: [
          {
            toolCallId: "call-stream",
            toolName: "bash",
            args: { command: "pnpm test" },
            blocks: [{ type: "text", text: "line-1" }],
            status: "running",
            isError: false,
          },
        ],
      });
    });

    for (let index = 2; index <= 60; index += 1) {
      const output = Array.from({ length: index }, (_, lineIndex) => `line-${lineIndex + 1}`).join(
        "\n",
      );
      await page.evaluate((text) => {
        window.__emitSse({
          type: "tools",
          tools: [
            {
              toolCallId: "call-stream",
              toolName: "bash",
              args: { command: "pnpm test" },
              blocks: [{ type: "text", text }],
              status: "running",
              isError: false,
            },
          ],
        });
      }, output);
    }

    await expect(page.locator(".tool-call .code-block").last()).toContainText("line-60");
    await expect(page.locator(".tool-call .code-block").last()).toContainText("line-41");
  });

  test("does not surprise-scroll when the user has scrolled up", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await installMocks(
      page,
      createSession({
        messages: createMessages(30),
      }),
    );

    await page.goto(`/workspaces/${workspace.id}/sessions/${summary.sessionId}`);
    await expect(page.locator(".transcript")).toBeVisible();

    await page.locator(".transcript").hover();
    await page.mouse.wheel(0, -300);

    const before = await page.locator(".transcript").evaluate((element) => element.scrollTop);

    await page.evaluate(() => {
      window.__emitSse({
        type: "status",
        isStreaming: true,
        pendingMessageCount: 0,
      });
      window.__emitSse({
        type: "assistant",
        assistant: {
          id: "assistant-stream-2",
          role: "assistant",
          timestamp: 31,
          blocks: [
            { type: "text", text: "Running command" },
            {
              type: "toolCall",
              id: "call-stream-2",
              name: "bash",
              arguments: { command: "pnpm test" },
            },
          ],
        },
      });
    });

    await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();

    for (let index = 1; index <= 40; index += 1) {
      const output = Array.from({ length: index }, (_, lineIndex) => `line-${lineIndex + 1}`).join(
        "\n",
      );
      await page.evaluate((text) => {
        window.__emitSse({
          type: "tools",
          tools: [
            {
              toolCallId: "call-stream-2",
              toolName: "bash",
              args: { command: "pnpm test" },
              blocks: [{ type: "text", text }],
              status: "running",
              isError: false,
            },
          ],
        });
      }, output);
    }

    const after = await page.locator(".transcript").evaluate((element) => element.scrollTop);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(8);
  });

  test("streams edit output, then replaces it with the final diff", async ({ page }) => {
    await installMocks(page, createSession({ messages: [] }));

    await page.goto(`/workspaces/${workspace.id}/sessions/${summary.sessionId}`);
    await expect(page.locator(".transcript")).toBeVisible();

    await page.evaluate(() => {
      window.__emitSse({
        type: "assistant",
        assistant: {
          id: "assistant-1",
          role: "assistant",
          timestamp: 3,
          blocks: [
            { type: "text", text: "Editing file" },
            {
              type: "toolCall",
              id: "call-1",
              name: "edit",
              arguments: {
                path: "src/client/components/ToolCallBlock.vue",
                oldText: "before",
                newText: "after",
              },
            },
          ],
        },
      });
      window.__emitSse({
        type: "tools",
        tools: [
          {
            toolCallId: "call-1",
            toolName: "edit",
            args: {
              path: "src/client/components/ToolCallBlock.vue",
              oldText: "before",
              newText: "after",
            },
            blocks: [
              { type: "text", text: "Replacing text in src/client/components/ToolCallBlock.vue" },
            ],
            status: "running",
            isError: false,
          },
        ],
      });
    });

    await expect(page.locator(".tool-call")).toHaveCount(1);
    await expect(page.locator(".tool-call__result")).toContainText(
      "Replacing text in src/client/components/ToolCallBlock.vue",
    );
    await expect(page.locator(".diff-block")).toContainText("before");
    await expect(page.locator(".diff-block")).toContainText("after");
    await expect(page.locator(".diff-block")).toContainText("1");

    await page.evaluate(() => {
      window.__emitSse({
        type: "state",
        state: {
          id: "web-1",
          sessionId: "session-1",
          workspaceId: "batty",
          cwd: "/root/github/batty",
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
                { type: "text", text: "Editing file" },
                {
                  type: "toolCall",
                  id: "call-1",
                  name: "edit",
                  arguments: {
                    path: "src/client/components/ToolCallBlock.vue",
                    oldText: "before",
                    newText: "after",
                  },
                },
              ],
            },
            {
              id: "tool-1",
              role: "toolResult",
              timestamp: 4,
              toolCallId: "call-1",
              toolName: "edit",
              blocks: [
                {
                  type: "text",
                  text: "Successfully replaced text in src/client/components/ToolCallBlock.vue.",
                },
              ],
              details: {
                diff: "  81   old line\n- 82 before\n+ 82 after\n  83   next line",
                firstChangedLine: 82,
              },
              isError: false,
            },
          ],
          activeTools: [],
        },
      });
    });

    await expect(page.locator(".tool-call__result")).not.toContainText(
      "Replacing text in src/client/components/ToolCallBlock.vue",
    );
    await expect(page.locator(".diff-block")).toContainText("82");
    await expect(page.locator(".diff-block")).toContainText("before");
    await expect(page.locator(".diff-block")).toContainText("after");
  });
});
