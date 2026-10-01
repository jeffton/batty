import { expect, test } from "@playwright/test";
import { authenticate } from "./auth";

const servers = [
  { name: "f2", config: { type: "http", url: "https://f2.example/mcp" }, scope: "global" },
  { name: "f2docs", config: { type: "http", url: "https://docs.example/mcp" }, scope: "global" },
  { name: "gemini", config: { type: "stdio", command: "gemini" }, scope: "global" },
  {
    name: "testlodge",
    config: { type: "http", url: "https://testlodge.example/mcp" },
    scope: "global",
  },
];

test("MCP layout, inline editing and relevant connection actions", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 850 });
  await authenticate(page);
  await page.route("**/api/settings/mcp*", async (route) => {
    const workspace = new URL(route.request().url()).searchParams.has("workspaceId");
    await route.fulfill({ json: { servers: workspace ? [] : servers, errors: [] } });
  });
  await page.route(/\/api\/workspaces\/[^/]+\/mcp$/, async (route) => {
    await route.fulfill({
      json: {
        errors: [],
        servers: servers.map((server, i) => ({
          name: server.name,
          scope: "global",
          source: "/.batty/mcp.json",
          state: i === 1 ? "needs-auth" : "connected",
          usesOAuth: server.config.type === "http",
          hasOAuthCredentials: i === 3,
          tools: Array.from({ length: [21, 3, 15, 13][i]! }, (_, j) => ({
            name: `tool_${j}`,
            exposure: "codemode",
            description: "Example tool",
          })),
        })),
      },
    });
  });
  await page.goto(`/workspaces/batty?e2e=${Date.now()}`);
  await page.getByRole("button", { name: /new session/i }).click();
  await page.getByRole("button", { name: "MCPs, skills and tools", exact: true }).click();
  const cards = page.locator(".mcp-settings__server");
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0).getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
  await expect(cards.nth(0).getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
  await expect(cards.nth(1).getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(cards.nth(3).getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Enabled f2", exact: true })).toBeChecked();
  const add = page.getByRole("button", { name: "Add server", exact: true });
  expect((await add.boundingBox())!.width).toBeLessThan(200);
  await page.screenshot({ path: testInfo.outputPath("mcp-list-light.png") });
  await page.getByRole("button", { name: "Edit f2docs", exact: true }).click();
  await expect(
    cards.nth(1).getByRole("textbox", { name: "MCP server configuration" }),
  ).toBeVisible();
  await expect(cards.nth(1).getByRole("switch", { name: "Global server" })).toBeChecked();
  await expect(
    cards.nth(1).getByRole("textbox", { name: "MCP server configuration" }),
  ).not.toHaveValue(/exposure/);
  await page.screenshot({ path: testInfo.outputPath("mcp-edit-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: testInfo.outputPath("mcp-edit-dark.png") });
  await cards.nth(1).getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("mcp-list-mobile.png") });
  expect(
    await page.locator(".mcp-settings").evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
});
