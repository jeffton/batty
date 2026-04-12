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

    await page
      .locator(".workspace-browser-pane__sessions .workspace-browser-pane__item")
      .first()
      .click();
    await expect(page).toHaveURL(sessionUrl);

    await page.reload();
    await expect(page).toHaveURL(sessionUrl);
    await expect(page.locator(".transcript")).toBeVisible();

    const relevantErrors = errors.filter((message) =>
      /availableThinkingLevels|Invalid time value|TypeError|RangeError/.test(message),
    );
    expect(relevantErrors).toEqual([]);
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
