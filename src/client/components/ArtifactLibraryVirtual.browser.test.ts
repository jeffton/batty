// @vitest-environment node
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "patchright";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { ArtifactLibraryItem, ArtifactLibraryResponse } from "@/shared/artifact-library";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { fixtureOperation } from "../test/socket-fixture";

const fixture = "src/client/components/ArtifactLibraryVirtual.fixture.html";
const base = "/nested/app";
const size = 50;
const total = size * 3 - 7;
const previewName = "Page boundary site";
const lastPreviewName = "Final page site";
const refreshedTitle = "Refreshed title.bin";
const longName = "Detail-with-a-long-unbroken-filename-".repeat(10) + ".bin";
const cursorAt = (generation: number, index: number) => `artifact /${generation}/${index}?+`;

function fixtureArtifacts(): ArtifactLibraryItem[] {
  return Array.from({ length: total }, (_, index) => {
    const id = String(index);
    const createdAt = new Date(Date.UTC(2026, 10, 26, 0, -index)).toISOString();
    const starred = index === 0;
    if (index === size - 1 || index === total - 2) {
      const title = index === size - 1 ? previewName : lastPreviewName;
      return {
        ref: `site:${id}`,
        title,
        createdAt,
        starred,
        kind: "site",
        site: { id, name: title, kind: "site", public: false, url: `/sites/${id}/` },
      };
    }
    const name = index === 1 ? longName : `Artifact ${index}.bin`;
    return {
      ref: `file:${id}`,
      title: name,
      createdAt,
      starred,
      kind: "file",
      source: "generated",
      file: {
        id,
        name,
        kind: "file",
        mimeType: "application/octet-stream",
        size: 4,
        downloadUrl: `${base}/api/sent-files/${id}?download=1`,
      },
    };
  });
}

let server: ViteDevServer;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  server = await createBrowserFixtureServer(fixture, {
    plugins: [vue()],
    define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
});

test.each([
  { name: "desktop", width: 1280, height: 840, mobile: false },
  { name: "mobile", width: 320, height: 660, mobile: true },
])(
  "paginates and virtualizes artifacts on $name",
  async ({ width, height, mobile }) => {
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    const allowFirstStarWrite = Promise.withResolvers<void>();

    try {
      const items = fixtureArtifacts();
      const requests: (string | null)[] = [];
      const writes: { ref: string; starred: boolean; limit: number }[] = [];
      const errors: string[] = [];
      let rejectNext = true;
      let generation = 0;
      const response = (start: number): ArtifactLibraryResponse => ({
        artifacts: items
          .toSorted(
            (a, b) =>
              Number(b.starred) - Number(a.starred) || b.createdAt.localeCompare(a.createdAt),
          )
          .slice(start, start + size),
        nextCursor: start + size < total ? cursorAt(generation, start + size) : undefined,
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await fixtureOperation(server, page, "site.get", ({ siteId }) => {
        const site = items.find((item) => item.kind === "site" && item.site.id === siteId);
        if (site?.kind !== "site") throw new Error("Missing site fixture");
        return { value: site.site };
      });

      await page.route(
        (url) => url.pathname === `${base}/api/artifacts`,
        async (route) => {
          const query = new URL(route.request().url()).searchParams;
          const after = query.get("after");
          requests.push(after);
          expect(query.get("limit")).toBe(String(size));
          if (after && rejectNext) {
            rejectNext = false;
            await route.fulfill({ status: 503 });
            return;
          }
          if (after && generation === 0) {
            generation++;
            items[3]!.title = refreshedTitle;
            await route.fulfill({
              status: 409,
              json: { code: "ARTIFACT_CATALOG_CHANGED", error: "Artifact list changed" },
            });
            return;
          }
          const start = after
            ? [size, 2 * size].find((index) => after === cursorAt(generation, index))!
            : 0;
          expect(start).toBeDefined();
          await route.fulfill({ json: response(start) });
        },
      );
      await page.route(`**${base}/api/artifacts/star`, async (route) => {
        expect(route.request().method()).toBe("PUT");
        const write = route.request().postDataJSON();
        writes.push(write);
        if (writes.length === 1) await allowFirstStarWrite.promise;
        items.find((item) => item.ref === write.ref)!.starred = write.starred;
        await route.fulfill({ json: response(0) });
      });
      await page.route(`**${base}/sites/*/**`, (route) =>
        route.fulfill({ contentType: "text/html", body: "<h1>Site preview</h1>" }),
      );

      const click = (target: ReturnType<typeof page.locator>) =>
        mobile ? target.tap() : target.click();
      const launcher = page.getByRole("button", { name: "Artifacts", exact: true });
      const library = page.getByRole("dialog", { name: "Artifacts" });
      const list = library.getByRole("list", { name: "Artifacts" });
      const viewport = library.locator(".artifact-library__viewport");
      const row = (ref: string) => list.locator(`[data-artifact-ref="${ref}"]`);
      const end = () => viewport.evaluate((element) => (element.scrollTop = element.scrollHeight));
      const top = () => viewport.evaluate((element) => (element.scrollTop = 0));
      const countMounted = () => list.getByRole("listitem").count();

      await page.goto(origin + fixture);
      await launcher.waitFor();
      expect(requests).toEqual([]);
      await click(launcher);
      await row("file:0").waitFor();
      await row("file:1").waitFor();
      expect(requests).toEqual([null]);
      expect(await countMounted()).toBeLessThan(size);
      expect(await row(`site:${size - 1}`).count()).toBe(0);
      if (mobile) {
        const short = (await row("file:0").boundingBox())!;
        const long = (await row("file:1").boundingBox())!;
        expect(long.height).toBeGreaterThan(short.height);
        expect(long.x + long.width).toBeLessThanOrEqual(width);
      }

      const firstStar = row("file:0").getByRole("button", { name: "Star Artifact 0.bin" });
      await firstStar.focus();
      await end();
      await library.getByRole("alert").waitFor();
      expect(requests).toEqual([null, cursorAt(0, size)]);
      expect(await firstStar.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await row("file:1").count()).toBe(0);
      await click(library.getByRole("button", { name: "Retry" }));
      await row("file:3").getByText(refreshedTitle).waitFor();
      expect(requests).toEqual([null, cursorAt(0, size), cursorAt(0, size), null]);
      await end();
      await row(`file:${size}`).waitFor();
      expect(requests.at(-1)).toBe(cursorAt(1, size));

      await click(
        row(`site:${size - 1}`).getByRole("button", { name: new RegExp(`^${previewName}`) }),
      );
      const preview = page.getByRole("dialog", { name: previewName });
      await preview.frameLocator("iframe").getByRole("heading", { name: "Site preview" }).waitFor();
      await top();
      await row("file:0").waitFor();
      expect(await row(`file:${size}`).count()).toBe(0);
      expect(await preview.isVisible()).toBe(true);
      await click(preview.getByRole("button", { name: "Close site" }));
      await preview.waitFor({ state: "hidden" });
      const trigger = row(`site:${size - 1}`).getByRole("button", {
        name: new RegExp(`^${previewName}`),
      });
      await expect
        .poll(() => trigger.evaluate((element) => element === document.activeElement))
        .toBe(true);

      await end();
      await row(`file:${2 * size}`).waitFor();
      expect(requests.at(-1)).toBe(cursorAt(1, 2 * size));
      await end();
      await row(`file:${total - 1}`).waitFor();
      expect(await countMounted()).toBeLessThan(size);

      const target = `file:${total - 1}`;
      const star = row(target).getByRole("button", { name: `Star Artifact ${total - 1}.bin` });
      await click(star);
      await expect.poll(() => writes.length).toBe(1);
      await click(
        row(`site:${total - 2}`).getByRole("button", {
          name: new RegExp(`^${lastPreviewName}`),
        }),
      );
      const lastPreview = page.getByRole("dialog", { name: lastPreviewName });
      await lastPreview
        .frameLocator("iframe")
        .getByRole("heading", { name: "Site preview" })
        .waitFor();
      const starResponse = page.waitForResponse(`**${base}/api/artifacts/star`);
      allowFirstStarWrite.resolve();
      await (await starResponse).finished();
      await top();
      await row("file:0").waitFor();
      expect(await lastPreview.isVisible()).toBe(true);
      await click(lastPreview.getByRole("button", { name: "Close site" }));
      await expect
        .poll(() =>
          list
            .locator("[data-artifact-ref]")
            .evaluateAll((rows) =>
              rows.slice(0, 2).map((element) => element.getAttribute("data-artifact-ref")),
            ),
        )
        .toEqual(["file:0", target]);
      expect(await star.getAttribute("aria-pressed")).toBe("true");
      expect(await viewport.evaluate((element) => element === document.activeElement)).toBe(true);
      await click(star);
      await expect.poll(() => row(target).count()).toBe(0);
      expect(await viewport.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(writes).toEqual([
        { ref: target, starred: true, limit: size },
        { ref: target, starred: false, limit: size },
      ]);
      expect(requests).toEqual([
        null,
        cursorAt(0, size),
        cursorAt(0, size),
        null,
        cursorAt(1, size),
        cursorAt(1, 2 * size),
      ]);
      expect(errors).toEqual([]);
    } finally {
      allowFirstStarWrite.resolve();
      await context.close();
    }
  },
  30_000,
);
