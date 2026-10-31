import fs from "node:fs/promises";
import { removeTestBrowserRoot } from "./test-browser-cleanup";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { acquireLock } from "./lock";
import { closeBrowserProcesses } from "./browser-maintenance";
import { BrowserService } from "./browser-service";
import { browserSessionDirectory } from "./browser-persistence";

test("browser maintenance refuses to race the running service", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-maintenance-lock-"));
  const unlock = await acquireLock(path.join(root, "runtime.lock"));
  try {
    await expect(closeBrowserProcesses(root)).rejects.toThrow("Another Batty2 process owns");
  } finally {
    await unlock();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("offline maintenance closes all workspace browsers and retains cookies for the next Chrome", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-maintenance-"));
  const browserRoot = path.join(root, "browser");
  let service = new BrowserService(undefined, 4, browserRoot);
  const server = http.createServer((_request, response) => response.end("fixture"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const key of ["one", "two"]) {
      const opened = await service.execute(key, { action: "open", url, cloud: true });
      const { page } = await service.cloudTarget(opened.details.sites![0]!.browserId);
      await page.context().addCookies([
        {
          name: "fixture",
          value: key,
          domain: "127.0.0.1",
          path: "/",
          expires: Date.now() / 1000 + 3600,
        },
      ]);
    }
    await service.dispose();
    expect(await closeBrowserProcesses(root)).toBe(2);
    for (const key of ["one", "two"]) {
      await expect(
        fs.access(path.join(browserSessionDirectory(browserRoot, key), "browser.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    service = new BrowserService(undefined, 4, browserRoot);
    for (const key of ["one", "two"]) {
      const opened = await service.execute(key, { action: "open", url, cloud: true });
      const { page } = await service.cloudTarget(opened.details.sites![0]!.browserId);
      const cookies = await page.context().cookies(url);
      expect(cookies.find((cookie) => cookie.name === "fixture")?.value).toBe(key);
    }
  } finally {
    await service.closeSession("one");
    await service.closeSession("two");
    await service.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTestBrowserRoot(root);
  }
}, 30_000);
