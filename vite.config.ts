import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite-plus";

const mockedServerTests = [
  "src/server/durable-bash.test.ts",
  "src/server/native-browser-video-process.test.ts",
  "src/server/browser-display.test.ts",
  "src/server/browser-persistence.test.ts",
  "src/server/web-push.test.ts",
  "src/server/browser-credentials.test.ts",
  "src/server/cloud-browser.test.ts",
  "src/server/network-probe.test.ts",
  "src/server/routes/assistant-agents.test.ts",
];

export default defineConfig({
  base: "./",
  define: { __BATTY_BUILD_ID__: JSON.stringify(process.env.BATTY_BUILD_ID ?? "dev") },
  plugins: [
    vue(),
    {
      name: "build-marker",
      transformIndexHtml: () => [
        {
          tag: "meta",
          attrs: { name: "batty-build", content: process.env.BATTY_BUILD_ID ?? "dev" },
          injectTo: "head",
        },
      ],
    },
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src/client",
      filename: "sw.ts",
      registerType: "prompt",
      includeAssets: ["favicon.png", "apple-touch-icon.png"],
      manifest: false,
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        globIgnores: ["index.html"],
      },
      devOptions: {
        enabled: true,
        type: "module",
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3148",
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    sourcemap: true,
  },
  test: {
    execArgv: ["--no-experimental-webstorage"],
    projects: [
      {
        test: {
          name: "server",
          environment: "node",
          include: ["src/server/**/*.test.ts", "src/shared/**/*.test.ts"],
          exclude: mockedServerTests,
          pool: "threads",
          isolate: false,
        },
      },
      {
        test: {
          // Module mocks need a fresh module graph; keep pure server tests fast.
          name: "server-mocked",
          environment: "node",
          include: mockedServerTests,
          pool: "threads",
          isolate: true,
        },
      },
      {
        test: {
          name: "client",
          environment: "happy-dom",
          include: ["src/client/**/*.test.ts"],
          exclude: ["src/**/*.browser.test.ts"],
          pool: "threads",
          isolate: true,
        },
      },
      {
        test: {
          name: "browser",
          // Browser startup, fixture compilation and systemd-backed calls are
          // integration work, not 5-second unit tests. Locator waits still fail fast.
          testTimeout: 30_000,
          environment: "node",
          include: ["src/**/*.browser.test.ts"],
          pool: "forks",
          isolate: true,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,vue}"],
      exclude: ["src/client/env.d.ts"],
    },
  },
  lint: {
    ignorePatterns: ["dist/**", "node_modules/**", ".batty/**", ".vite-plus/**"],
  },
  fmt: {
    ignorePatterns: [".vite-plus/**", "docs/references/optchat-spec.md"],
  },
  pack: {
    deps: { resolveDepSubpath: true },
    entry: {
      main: "src/server/main.ts",
      "cron-cli": "src/server/cron-cli.ts",
      "stop-service": "src/server/stop-service.ts",
      "verify-browser-isolation": "scripts/verify-browser-isolation.ts",
      "close-browsers": "scripts/close-browsers.ts",
    },
    outDir: "dist/server",
    format: ["esm"],
    target: "node24",
    dts: false,
    clean: true,
    sourcemap: true,
    shims: false,
  },
  staged: {
    "*.{ts,vue,css,html,json,md}": "vp check --fix",
  },
});
