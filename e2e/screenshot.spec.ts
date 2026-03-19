import { test } from "@playwright/test";
import { authenticate } from "./auth";

test("screenshots", async ({ page }) => {
  await authenticate(page);
  await page.goto("/");
  await page.waitForTimeout(1500);

  // Start a session so model btn is active
  await page.click(".header__ws-btn");
  await page.waitForTimeout(300);
  await page.locator(".ws-popover__new-session").click();
  await page.waitForTimeout(1500);

  await page.screenshot({ path: "screenshots/header-light.png" });

  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: "screenshots/header-dark.png" });
});
