import { test } from "@playwright/test";
import { authenticate } from "./auth";

test("screenshots", async ({ page }) => {
  await authenticate(page);
  await page.goto(`/workspaces/batty?e2e=${Date.now()}`);
  await page.waitForTimeout(1500);

  await page.getByRole("button", { name: /new session/i }).click();
  await page.waitForTimeout(1500);

  await page.screenshot({ path: "screenshots/header-light.png" });

  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: "screenshots/header-dark.png" });
});
