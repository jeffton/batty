import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type InlineConfig, type ViteDevServer } from "vite";

export async function createBrowserFixtureServer(fixture: string, config: InlineConfig) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "batty-vite-fixture-"));
  try {
    return await createServer({
      ...config,
      configFile: false,
      cacheDir,
      // These imports are reached after the HTML scan. Prebundle them before
      // navigation so dependency discovery cannot reload an active fixture.
      optimizeDeps: {
        entries: [fixture],
        include: [
          "@pierre/diffs",
          "@oddbird/css-anchor-positioning/fn",
          "@simplewebauthn/browser",
          "pinia-plugin-persistedstate",
          "vue-router",
        ],
      },
    });
  } catch (error) {
    await rm(cacheDir, { recursive: true });
    throw error;
  }
}

export async function closeBrowserFixtureServer(server: ViteDevServer) {
  try {
    await server.close();
  } finally {
    await rm(server.config.cacheDir, { recursive: true });
  }
}
