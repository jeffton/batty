import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: "http://127.0.0.1:3147",
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm start",
    url: "http://127.0.0.1:3147/healthz",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
