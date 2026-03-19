import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: "http://127.0.0.1:33147",
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm exec tsx e2e/prepare.ts && BATTY_PORT=33147 pnpm start -- .",
    url: "http://127.0.0.1:33147/healthz",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
