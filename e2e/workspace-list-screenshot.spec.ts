import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { authenticate } from "./auth";

const workspaceRoot = path.join(process.cwd(), ".batty", "e2e-workspaces");
const workspaceNames = ["alpha", "batty", "delta", "zeta"];

test("workspace list screenshot", async ({ page }) => {
  await Promise.all(
    workspaceNames.map((name) => fs.mkdir(path.join(workspaceRoot, name), { recursive: true })),
  );

  await authenticate(page);
  await page.goto(`/workspaces/batty?e2e=${Date.now()}`);

  await expect(page.locator(".workspace-browser-pane")).toBeVisible();
  await expect(
    page.locator(".workspace-browser-pane__item-row", { hasText: "alpha" }),
  ).toBeVisible();
  await expect(
    page.locator(".workspace-browser-pane__item-row", { hasText: "zeta" }),
  ).toBeVisible();

  await page
    .locator(".workspace-browser-pane__item-row", { hasText: "delta" })
    .getByRole("button", { name: /pin workspace/i })
    .click();
  await page
    .locator(".workspace-browser-pane__item-row", { hasText: "zeta" })
    .getByRole("button", { name: /pin workspace/i })
    .click();

  await expect(page.locator(".workspace-browser-pane__item-row").first()).toContainText("delta");
  await expect(page.locator(".workspace-browser-pane__item-row").nth(1)).toContainText("zeta");

  await page.locator(".workspace-browser-pane__column").first().screenshot({
    path: "screenshots/workspace-list.png",
  });
});
