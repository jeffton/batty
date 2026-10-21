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
      // Vite can also transform the app entry while serving a fixture. Scan
      // both graphs before navigation so discovering app dependencies cannot
      // reoptimize shared chunks and reload an active fixture.
      optimizeDeps: {
        entries: [fixture, "src/client/main.ts"],
        // The SFC scanner does not discover this on-demand import.
        include: ["@pierre/diffs"],
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
