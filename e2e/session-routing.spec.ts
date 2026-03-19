import { SessionManager } from "@mariozechner/pi-coding-agent";
import { expect, test } from "@playwright/test";
import { authenticate } from "./auth";

function createSeedSession() {
  const session = SessionManager.create(process.cwd());
  const label = `playwright seed ${Date.now()}`;
  const now = Date.now();

  session.appendMessage({
    role: "user",
    content: label,
    timestamp: now,
  });
  session.appendMessage({
    role: "assistant",
    content: "seeded response",
    timestamp: now + 1,
  });

  return {
    label,
    sessionId: session.getSessionId(),
  };
}

test("opening a session keeps the main pane healthy and survives reload", async ({ page }) => {
  const { label, sessionId } = createSeedSession();
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
  await page.goto("/");

  await expect(page).toHaveURL(/\/workspaces\/batty$/);
  await expect(page.locator(".header__ws-name")).toHaveText("batty");

  // Open workspace popover and click the session
  await page.click(".header__ws-btn");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: label }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/batty/sessions/${sessionId}$`));
  await expect(page.locator(".transcript")).toBeVisible();

  const sessionUrl = page.url();

  // Navigate back to workspace root
  await page.goto("/workspaces/batty");
  await expect(page).toHaveURL(/\/workspaces\/batty$/);
  await expect(page.getByText("No active session")).toBeVisible();

  // Re-open session via popover
  await page.click(".header__ws-btn");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: label }).click();
  await expect(page).toHaveURL(sessionUrl);
  await expect(page.locator(".transcript")).toBeVisible();

  // Reload survives
  await page.reload();
  await expect(page).toHaveURL(sessionUrl);
  await expect(page.locator(".transcript")).toBeVisible();

  const relevantErrors = errors.filter((message) =>
    /availableThinkingLevels|Invalid time value|TypeError|RangeError/.test(message),
  );
  expect(relevantErrors).toEqual([]);
});
