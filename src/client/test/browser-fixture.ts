import { createHash } from "node:crypto";
import path from "node:path";
import { createServer, type InlineConfig, type ViteDevServer } from "vite";

export async function createBrowserFixtureServer(fixture: string, config: InlineConfig) {
  // Keep Vite's dependency cache between runs, with one namespace per fixture.
  // Vite invalidates it when dependencies or optimizer configuration change.
  const cacheDir = path.resolve(
    "node_modules/.vite/batty-fixtures",
    createHash("sha256").update(fixture).digest("hex").slice(0, 16),
  );
  return await createServer({
    ...config,
    configFile: false,
    cacheDir,
    // Scan both graphs before navigation: discovering app dependencies during a
    // fixture can otherwise reoptimize shared chunks and reload the active page.
    optimizeDeps: {
      entries: [fixture, "src/client/main.ts"],
      // The SFC scanner does not discover this on-demand import.
      include: ["@pierre/diffs"],
    },
  });
}

export async function closeBrowserFixtureServer(server: ViteDevServer) {
  await server.close();
}
