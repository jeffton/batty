// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { BrowserService } from "./browser-service";
import { browserSessionDirectory } from "./browser-persistence";
import { removeBrowserIsolation } from "./browser-isolation";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-action-timeout-"));
  const website = http.createServer((_, response) => response.end("<h1>Ready</h1>"));
  website.listen(0, "127.0.0.1");
  await once(website, "listening");
  const url = `http://127.0.0.1:${(website.address() as { port: number }).port}/`;
  const service = new BrowserService(undefined, 4, root);
  const directory = browserSessionDirectory(root, "worker");
  return {
    service,
    directory,
    url,
    async close() {
      await service.closeSession("worker");
      await service.dispose();
      website.closeAllConnections();
      await new Promise<void>((resolve) => website.close(() => resolve()));
      await removeBrowserIsolation(directory);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

describe("browser action cancellation", () => {
  let state: Awaited<ReturnType<typeof fixture>>;

  beforeAll(async () => {
    state = await fixture();
    await state.service.execute("worker", { action: "open", url: state.url });
  });

  beforeEach(async () => {
    // These cases must preserve the process. Reuse it, but discard every target
    // page and clear storage so each case starts with the same clean survivor.
    const { service, url } = state;
    const pages = await service.execute("worker", { action: "pages" });
    for (const page of pages.details.pages!) {
      if (page.id !== "page-1")
        await service.execute("worker", { action: "close-page", pageId: page.id });
    }
    await service.execute("worker", { action: "open", pageId: "page-1", url });
    await service.execute("worker", {
      action: "evaluate",
      script: "() => { localStorage.clear(); sessionStorage.clear(); }",
    });
  });

  afterAll(async () => {
    await state.close();
  });

  test.each([false, true])(
    "queued cancellation leaves a running evaluate and following actions intact (%s)",
    async (interrupted) => {
      const { service } = state;
      const predecessor = service.execute("worker", {
        action: "evaluate",
        script:
          "() => new Promise(resolve => setTimeout(() => { localStorage.setItem('finished', 'yes'); resolve('finished'); }, 1200))",
      });
      const controller = new AbortController();
      const waiting = service.execute(
        "worker",
        { action: "pages", timeoutMs: 1000 },
        controller.signal,
      );
      const rejected = expect(waiting).rejects.toThrow(
        interrupted ? "Stopped" : "Browser pages exceeded timeoutMs",
      );
      const following = service.execute("worker", {
        action: "evaluate",
        script: "() => localStorage.getItem('finished')",
      });
      if (interrupted) controller.abort(new Error("Stopped"));
      await rejected;
      expect((await predecessor).text).toContain("Evaluation result:\nfinished");
      expect((await following).text).toContain("Evaluation result:\nyes");
      expect((await service.execute("worker", { action: "pages" })).details.pages).toHaveLength(1);
    },
  );

  test.each([false, true])(
    "missing selector cancellation preserves every tab and prevents a late click (%s)",
    async (interrupted) => {
      const { service, url } = state;
      await service.execute("worker", { action: "open", url, newPage: true });
      const controller = new AbortController();
      const pending = service.execute(
        "worker",
        { action: "click", selector: "#late", timeoutMs: 1000 },
        controller.signal,
      );
      const rejected = expect(pending).rejects.toThrow();
      if (interrupted) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.abort(new Error("Stopped"));
      }
      await rejected;
      const pages = await service.execute("worker", { action: "pages" });
      expect(pages.details.pages).toHaveLength(2);
      await service.execute("worker", {
        action: "evaluate",
        script:
          "() => { const b = document.createElement('button'); b.id='late'; b.onclick=() => document.body.dataset.clicked='yes'; document.body.append(b); }",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        (
          await service.execute("worker", {
            action: "evaluate",
            script: "() => document.body.dataset.clicked",
          })
        ).text,
      ).toContain("Evaluation result:\nundefined");
    },
  );

  test.each([false, true])(
    "cancelled evaluate destroys only its target, stopping delayed JavaScript (%s)",
    async (interrupted) => {
      const { service, url } = state;
      await service.execute("worker", { action: "open", url, newPage: true });
      const controller = new AbortController();
      const pending = service.execute(
        "worker",
        {
          action: "evaluate",
          script:
            "() => new Promise(() => { setTimeout(() => localStorage.setItem('late', 'bad'), 2000); })",
          timeoutMs: 1000,
        },
        controller.signal,
      );
      const rejected = expect(pending).rejects.toThrow();
      if (interrupted) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.abort(new Error("Stopped"));
      }
      await rejected;
      const pages = await service.execute("worker", { action: "pages" });
      expect(pages.details.pages).toHaveLength(1);
      expect(pages.text).toContain("page-1");
      await expect(service.execute("worker", { action: "snapshot" })).rejects.toThrow(
        "Unknown browser page",
      );
      await service.execute("worker", { action: "switch", pageId: "page-1" });
      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect(
        (
          await service.execute("worker", {
            action: "evaluate",
            script: "() => localStorage.getItem('late')",
          })
        ).text,
      ).toContain("Evaluation result:\nnull");
    },
  );
});
