// @vitest-environment node
import path from "node:path";
import fs from "node:fs/promises";
import { inflateSync } from "node:zlib";
import vue from "@vitejs/plugin-vue";
import { chromium } from "patchright";
import { expect, test } from "vite-plus/test";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

test("Neon follows system appearance without recoloring controls and supplies genuine PQ highlights", async () => {
  const png = await fs.readFile("src/client/assets/neon-pq.png");
  const chunks = new Map<string, Buffer>();
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    chunks.set(
      png.toString("ascii", offset + 4, offset + 8),
      png.subarray(offset + 8, offset + 8 + length),
    );
    offset += length + 12;
  }
  expect([...chunks.get("cICP")!]).toEqual([9, 16, 0, 1]);
  expect(chunks.get("IHDR")![8]).toBe(16);
  const pixels = inflateSync(chunks.get("IDAT")!);
  const decodePq = (value: number) => {
    const p = (value / 65535) ** (32 / 2523);
    return (
      10000 * (Math.max(p - 3424 / 4096, 0) / (2413 / 128 - (2392 / 128) * p)) ** (16384 / 2610)
    );
  };
  // BT.2020 luminance of the cyan endpoint exceeds 203-nit diffuse white.
  const luminance = [0.2627, 0.678, 0.0593].reduce(
    (sum, weight, channel) => sum + weight * decodePq(pixels.readUInt16BE(1 + channel * 2)),
    0,
  );
  expect(luminance).toBeGreaterThan(400);
  expect(luminance).toBeLessThan(650);

  const server = await createBrowserFixtureServer(
    "src/client/components/SettingsPopover.fixture.html",
    {
      plugins: [vue()],
      define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
      resolve: { alias: { "@": path.resolve("src") } },
      server: { host: "127.0.0.1", port: 0 },
    },
  );
  const browser = await chromium.launch({ headless: true });
  try {
    await server.listen();
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      colorScheme: "light",
    });
    await page.route("**/api/**", (route) => route.fulfill({ json: { names: [] } }));
    await page.goto(
      `${server.resolvedUrls!.local[0]}src/client/components/SettingsPopover.fixture.html`,
    );
    await page.evaluate(`(async () => {
      const { applyAppAppearance } = await import("/src/client/lib/appearance.ts");
      applyAppAppearance({title:"Batty",color:"neon"});
    })()`);
    for (const colorScheme of ["light", "dark", "light"] as const) {
      await page.emulateMedia({ colorScheme });
      const style = await page.locator("#settings .full-popover__header").evaluate((element) => {
        const computed = getComputedStyle(element);
        const sample = document.createElement("canvas").getContext("2d")!;
        const rgb = (color: string) => {
          sample.fillStyle = color;
          sample.fillRect(0, 0, 1, 1);
          return [...sample.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        return {
          background: computed.backgroundColor,
          text: rgb(computed.color),
          base: rgb(computed.backgroundColor),
          edge: getComputedStyle(element, "::after").backgroundImage,
          hdr: matchMedia("(dynamic-range: high)").matches,
        };
      });
      expect(style.background).toBe(
        colorScheme === "light" ? "rgb(247, 251, 255)" : "rgb(16, 25, 35)",
      );
      const luminanceOf = (rgb: number[]) =>
        rgb.reduce((sum, value, channel) => {
          const c = value / 255;
          return (
            sum +
            [0.2126, 0.7152, 0.0722][channel]! *
              (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
          );
        }, 0);
      const values = [luminanceOf(style.text), luminanceOf(style.base)].sort((a, b) => b - a);
      expect((values[0]! + 0.05) / (values[1]! + 0.05)).toBeGreaterThan(7);
      expect(style.edge).toContain(style.hdr ? "neon-pq.png" : "linear-gradient");
    }
    const image = await page.evaluate(async () => {
      const img = new Image();
      img.src = "/src/client/assets/neon-pq.png";
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight };
    });
    expect(image).toEqual({ width: 256, height: 1 });
    // Capability reporting does not claim the SDR host is an HDR display.
    await page.emulateMedia({ media: "screen" });
    const capabilities = await page.evaluate(() => ({
      hdr: matchMedia("(dynamic-range: high)").matches,
      cssPq: CSS.supports("color", "color(rec2100-pq 0.7 0.7 0.7)"),
      limit: CSS.supports("dynamic-range-limit", "no-limit"),
    }));
    console.log("Neon host capabilities:", capabilities);
  } finally {
    await browser.close();
    await closeBrowserFixtureServer(server);
  }
});
