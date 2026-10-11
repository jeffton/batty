import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite-plus";

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
    environment: "happy-dom",
    execArgv: ["--no-experimental-webstorage"],
    include: ["src/**/*.test.ts"],
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
    entry: ["src/server/main.ts", "src/server/cron-cli.ts"],
    outDir: "dist/server",
    format: ["esm"],
    target: "node24",
    dts: false,
    clean: false,
    sourcemap: true,
    shims: false,
  },
  staged: {
    "*.{ts,vue,css,html,json,md}": "vp check --fix",
  },
});
