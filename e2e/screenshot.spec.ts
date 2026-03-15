import { test } from "@playwright/test";

const PASSWORD = "pi-face-d3mQm4Hc-9rY2Qv7-7nLk";

test("screenshots", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(800);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button:has-text("Unlock")');
  await page.waitForTimeout(1500);

  // Light workspace popover
  await page.click('.header__ws-btn');
  await page.waitForTimeout(400);
  await page.screenshot({ path: "screenshots/ws-light.png" });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // Dark mode
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await page.click('.header__ws-btn');
  await page.waitForTimeout(400);
  await page.screenshot({ path: "screenshots/ws-dark.png" });
});
