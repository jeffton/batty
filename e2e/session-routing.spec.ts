import { expect, test } from "@playwright/test";
import { authenticate } from "./auth";

test.describe("workspace and session routing", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("session selection and back/forward navigation keep the shell healthy", async ({ page }) => {
    const errors: string[] = [];

    page.on("pageerror", (error) => {
      errors.push(error.message);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });

    await authenticate(page);
    await page.goto(`/workspaces/batty?e2e=${Date.now()}`);

    await expect(page).toHaveURL(/\/workspaces\/batty(?:\?e2e=\d+)?$/);
    await expect(page.locator(".workspace-browser-pane")).toBeVisible();

    await page.getByRole("button", { name: /new session/i }).click();
    await expect(page).toHaveURL(/\/workspaces\/batty\/sessions\/[^/]+$/);
    await expect(page.locator(".transcript")).toBeVisible();
    await expect(page.locator(".header__ws-btn")).toBeVisible();

    const sessionUrl = page.url();

    await page.locator(".header__ws-btn").click();
    await expect(page).toHaveURL(/\/workspaces\/batty(?:\?e2e=\d+)?$/);
    await expect(page.locator(".workspace-browser-pane")).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(sessionUrl);
    await expect(page.locator(".transcript")).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/workspaces\/batty(?:\?e2e=\d+)?$/);
    await expect(page.locator(".workspace-browser-pane")).toBeVisible();
    await expect(page.locator(".workspace-browser-pane")).toHaveAttribute("aria-hidden", "false");
    await expect(page.locator(".chat-session-pane")).toHaveAttribute("aria-hidden", "true");

    const sessionId = decodeURIComponent(new URL(sessionUrl).pathname.split("/").at(-1)!);
    const sessionItem = page.locator(
      `.workspace-browser-pane__sessions [data-session-id="${sessionId}"]`,
    );
    await expect(sessionItem).toHaveCount(1);
    await sessionItem.click();
    await expect(page).toHaveURL(sessionUrl);

    await page.reload();
    await expect(page).toHaveURL(sessionUrl);
    await expect(page.locator(".transcript")).toBeVisible();

    const relevantErrors = errors.filter((message) =>
      /availableThinkingLevels|Invalid time value|TypeError|RangeError/.test(message),
    );
    expect(relevantErrors).toEqual([]);
  });

  test("workspace browsing pauses transcript streaming and returning resumes it", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      const sources: EventSource[] = [];
      (window as typeof window & { testSessionSources: EventSource[] }).testSessionSources =
        sources;
      window.EventSource = class extends NativeEventSource {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          if (String(url).includes("/api/sessions/")) sources.push(this);
        }
      };
    });

    await authenticate(page);
    await page.goto(`/workspaces/batty?e2e=${Date.now()}`);
    await page.getByRole("button", { name: /new session/i }).click();
    await page.waitForFunction(() => {
      const sources = (window as typeof window & { testSessionSources: EventSource[] })
        .testSessionSources;
      return sources[0]?.readyState === EventSource.OPEN;
    });

    const sessionId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
    const state = await page.evaluate(async (id) => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
      return response.json();
    }, sessionId);
    const completed = {
      ...state,
      revision: state.revision + 2,
      updatedAt: Date.now(),
      isStreaming: false,
      messagesDetailLevel: "full",
      totalMessageCount: 1,
      messages: [
        {
          id: "completed-0",
          role: "assistant",
          turnPhase: "final",
          timestamp: Date.now(),
          blocks: [{ type: "text", text: "Finished while browsing" }],
        },
      ],
    };
    await page.evaluate(
      (payload) => {
        (
          window as typeof window & { testSessionSources: EventSource[] }
        ).testSessionSources[0]!.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(payload) }),
        );
      },
      {
        type: "reset",
        streamId: state.streamId,
        revision: state.revision + 1,
        state: {
          ...state,
          revision: state.revision + 1,
          isStreaming: true,
          messagesDetailLevel: "summary",
        },
      },
    );
    await page.route(`**/api/workspaces/batty/sessions`, (route) =>
      route.fulfill({
        json: [
          {
            id: state.path,
            path: state.path,
            sessionId,
            workspaceId: "batty",
            firstMessage: "prompt",
            updatedAt: completed.updatedAt,
            messageCount: 1,
            isInProgress: false,
          },
        ],
      }),
    );
    await page.route(`**/api/sessions/${sessionId}`, (route) => route.fulfill({ json: completed }));
    await page.route(`**/api/sessions/${sessionId}/events?*`, (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "reset", streamId: state.streamId, revision: completed.revision, state: { ...completed, messagesDetailLevel: "summary" } })}\n\n`,
      }),
    );

    await page.locator(".header__ws-btn").click();
    await expect(page).toHaveURL(/\/workspaces\/batty(?:\?e2e=\d+)?$/);
    await expect(
      page.locator(".workspace-browser-pane__item-row--session .workspace-browser-pane__spinner"),
    ).toHaveCount(0);
    await expect(page.getByText("Finished while browsing")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { testSessionSources: EventSource[] }).testSessionSources[0]
              ?.readyState,
        ),
      )
      .toBe(2);

    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { testSessionSources: EventSource[] }).testSessionSources
            .length,
      ),
    ).toBe(1);

    await page.goForward();
    await page.waitForFunction(() => {
      const sources = (window as typeof window & { testSessionSources: EventSource[] })
        .testSessionSources;
      return sources.length === 2;
    });
    const resumedUrl = await page.evaluate(
      () =>
        (window as typeof window & { testSessionSources: EventSource[] }).testSessionSources[1]!
          .url,
    );
    expect(new URL(resumedUrl).searchParams.has("afterRevision")).toBe(true);
    expect(new URL(resumedUrl).searchParams.has("afterStreamId")).toBe(true);
    await expect(page.getByText("Finished while browsing")).toBeVisible();
    await expect(page.locator(".composer__stream-actions")).toHaveCount(0);
  });

  test("back navigation keeps existing sessions visible during refresh", async ({ page }) => {
    await authenticate(page);
    await page.goto(`/workspaces/batty?e2e=${Date.now()}`);
    await page.getByRole("button", { name: /new session/i }).click();
    await expect(page).toHaveURL(/\/workspaces\/batty\/sessions\/[^/]+$/);
    const sessionId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);

    let releaseRefresh!: () => void;
    const refreshPending = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    await page.route("**/api/workspaces/batty/sessions", async (route) => {
      await refreshPending;
      await route.continue();
    });

    try {
      await page.locator(".header__ws-btn").click();
      await expect(page).toHaveURL(/\/workspaces\/batty(?:\?e2e=\d+)?$/);
      const sessionItem = page.locator(`[data-session-id="${sessionId}"]`);
      await expect(sessionItem).toBeVisible();
      await expect(sessionItem).toBeEnabled();
    } finally {
      releaseRefresh();
    }
  });

  test("streamed assistant blocks render and completion leaves back navigation responsive", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          if (String(url).includes("/api/sessions/")) {
            (window as typeof window & { testSessionSource?: EventSource }).testSessionSource =
              this;
          }
        }
      };
    });

    await authenticate(page);
    await page.goto(`/workspaces/batty?e2e=${Date.now()}`);
    await page.getByRole("button", { name: /new session/i }).click();
    await expect(page).toHaveURL(/\/workspaces\/batty\/sessions\/[^/]+$/);
    const sessionId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
    await page.waitForFunction(() => {
      const source = (window as typeof window & { testSessionSource?: EventSource })
        .testSessionSource;
      return source?.readyState === EventSource.OPEN && Boolean(source.onmessage);
    });
    const state = await page.evaluate(async (id) => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
      return response.json();
    }, sessionId);
    const assistant = {
      id: "assistant-live-1",
      role: "assistant",
      turnPhase: "pending",
      timestamp: Date.now(),
      blocks: [
        { type: "thinking", thinking: "" },
        { type: "text", text: "Hello" },
      ],
    };
    const sourceEvent = (event: object) =>
      page.evaluate((payload) => {
        (
          window as typeof window & { testSessionSource: EventSource }
        ).testSessionSource.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(payload) }),
        );
      }, event);
    await sourceEvent({
      type: "reset",
      revision: state.revision + 1,
      streamId: state.streamId,
      state: {
        ...state,
        revision: state.revision + 1,
        isStreaming: true,
        messages: [
          {
            id: "assistant-tool-0",
            role: "assistant",
            turnPhase: "intermediate",
            timestamp: Date.now() - 1000,
            blocks: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }],
          },
        ],
        totalMessageCount: 1,
        activeAssistant: assistant,
      },
    });
    await sourceEvent({
      type: "assistant-delta",
      revision: state.revision + 2,
      streamId: state.streamId,
      contentIndex: 1,
      blockType: "text",
      delta: " world",
    });
    await expect(page.getByText("Hello world")).toBeVisible();
    await sourceEvent({
      type: "reset",
      revision: state.revision + 3,
      streamId: state.streamId,
      state: { ...state, revision: state.revision + 3, isStreaming: false },
    });
    await expect(page.locator(".composer__stream-actions")).toHaveCount(0);
    await page.locator(".header__ws-btn").click();
    await expect(page).toHaveURL(/\/workspaces\/batty(?:\?e2e=\d+)?$/);
    expect(errors).toEqual([]);
  });

  test("creating a workspace from the browser opens a new session", async ({ page }) => {
    const workspaceName = `playwright-workspace-${Date.now()}`;

    await authenticate(page);
    await page.goto(`/workspaces/batty?e2e=${Date.now()}`);

    await page.getByRole("button", { name: /new workspace/i }).click();
    await page.getByPlaceholder("workspace-name").fill(workspaceName);
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceName}/sessions/[^/]+$`));
    await expect(page.getByRole("heading", { name: "No active session" })).toHaveCount(0);
    await expect(page.locator(".header__ws-name")).toHaveText(workspaceName);
  });
});
