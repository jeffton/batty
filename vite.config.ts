import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite-plus";

export default defineConfig({
  base: "./",
  plugins: [
    vue(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src/client",
      filename: "sw.ts",
      registerType: "autoUpdate",
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
      "/api": "http://127.0.0.1:3147",
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    sourcemap: true,
  },
  test: {
    environment: "happy-dom",
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
    ignorePatterns: [".vite-plus/**"],
  },
  pack: {
    entry: ["src/server/main.ts", "src/server/add-user.ts", "src/server/cli.ts"],
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
